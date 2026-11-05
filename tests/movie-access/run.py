#!/usr/bin/env python3
"""Default: offline file checks. SQL requires --run-disposable-db explicitly."""
import argparse
import ast
from collections import namedtuple
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MIGRATION = '20261104000100_movie_log_access_privileges.sql'
IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.002'
ORIGINALS = {
    '20261024000100_tmdb_rate_limit.sql': 'ddfb46a2e436fe7b2fe5293702c10d1b677ff0d5ab6f401fa59ffe6aef6301d9',
    '20261031000100_google_invite_auth.sql': '87aff6808ce2ba67ee29c1af964c296fe01e749cc2fa22fc80c0e5108fa4a66b',
    '20261103085903_movie_log_local_schema.sql': '46abc475cec448f704b3cd6f525a4d88559ed31fbaf605bd79a67d6c10551619',
    '20261103094134_movie_log_delete_function.sql': '40b98277fdf43554d80b3295b0c71b572cd988f725ed91379fc580eb9de321d1',
}
MIGRATIONS = tuple(ORIGINALS) + (MIGRATION,)
Case = namedtuple('Case', 'name upgrade broad')
CASES = (Case('fresh-restricted', False, False), Case('fresh-broad', False, True),
         Case('upgrade-restricted', True, False), Case('upgrade-broad', True, True))
Step = namedtuple('Step', 'kind name user')
MEMORY = 1024 * 1024 * 1024
TMPFS_SIZE = 512 * 1024 * 1024
CPU_NANO, PIDS = 1_000_000_000, 128
COMMAND_SECONDS, PATTERN_SECONDS, SUITE_SECONDS, CLEANUP_SECONDS = 20, 240, 1200, 20
TMPFS = 'rw,nosuid,nodev,size=' + str(TMPFS_SIZE) + ',mode=1777'
INITDB_STARTED = 'MOVIE_ACCESS_STARTUP:initdb-started'
INITDB_FAILED = 'MOVIE_ACCESS_STARTUP:initdb-failed'
POSTGRES_STARTING = 'MOVIE_ACCESS_STARTUP:postgres-starting'
STARTUP_MESSAGES = {
    INITDB_STARTED: 'initdb_did_not_complete',
    INITDB_FAILED: 'initdb_failed',
    POSTGRES_STARTING: 'postgres_start_or_runtime_failed',
}
INSPECT_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"label":{{json (index .Config.Labels "movie-log-access-test")}},'
    '"user":{{json .Config.User}},"running":{{json .State.Running}},'
    '"exit_code":{{json .State.ExitCode}},"oom_killed":{{json .State.OOMKilled}},'
    '"host":{{json .HostConfig}},"mounts":{{json .Mounts}},'
    '"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}}}'
)


class Failure(Exception):
    """Report controlled metadata and sanitized diagnostics, never command output."""
    def __init__(self, stage, reason, sqlstate=None, *, phase=None, mismatches=(),
                 container_state=None, startup_message='startup_step_unknown'):
        self.stage, self.reason, self.sqlstate = stage, reason, sqlstate
        self.phase = phase if phase in ('pre-start', 'post-start', 'post-tests') else 'unspecified' if phase else None
        # Store only sanitized diagnostics, never the inspect object itself.
        self.mismatches = tuple(mismatches)
        self.container_state = (safe_container_state(container_state, startup_message)
                                if container_state is not None else None)
        super().__init__('Diagnostic content suppressed')


def report_failure(error, case='suite'):
    if isinstance(error, Failure):
        print('FAIL pattern=' + case + ' stage=' + error.stage + ' reason=' + error.reason
              + (' phase=' + error.phase if error.phase else '')
              + (' SQLSTATE=' + error.sqlstate if error.sqlstate else ''), file=sys.stderr)
        for mismatch in error.mismatches:
            print('MISMATCH ' + json.dumps({
                'phase': error.phase, 'item': mismatch['item'],
                'expected': mismatch['expected'], 'actual': mismatch['actual'],
            }, ensure_ascii=True, sort_keys=True), file=sys.stderr)
        if error.container_state is not None:
            print('CONTAINER ' + json.dumps(dict(error.container_state, phase=error.phase),
                                           ensure_ascii=True, sort_keys=True), file=sys.stderr)
    else:
        print('FAIL pattern=' + case + ' reason=unexpected_error_details_suppressed', file=sys.stderr)


class Budget:
    def __init__(self, seconds, parent=None):
        self.end = time.monotonic() + seconds
        if parent is not None:
            self.end = min(self.end, parent.end)

    def timeout(self, stage, requested=COMMAND_SECONDS):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise Failure(stage, 'deadline_exceeded')
        return min(requested, remaining)


def command(args, source=None, timeout=COMMAND_SECONDS):
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM')
           if k in os.environ}
    return subprocess.run(args, input=source, text=True, capture_output=True,
                          timeout=timeout, env=env)


def sqlstate(stderr):
    match = re.search(r'(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):', stderr)
    return match[1] if match else None


def checked(args, stage, budget, source=None, allow_failure=False, timeout=COMMAND_SECONDS):
    try:
        result = command(args, source, budget.timeout(stage, timeout))
    except subprocess.TimeoutExpired:
        raise Failure(stage, 'command_timeout') from None
    except OSError:
        raise Failure(stage, 'command_unavailable') from None
    if result.returncode and not allow_failure:
        raise Failure(stage, 'command_or_sql_error', sqlstate(result.stderr))
    return result


def socket_path(endpoint):
    url = urlsplit(endpoint)
    if url.scheme != 'unix' or url.netloc or url.query or url.fragment:
        raise Failure('docker-endpoint', 'local_unix_socket_required')
    path = Path(unquote(url.path))
    if not path.is_absolute():
        raise Failure('docker-endpoint', 'absolute_socket_required')
    return path


def local_docker(budget):
    context = os.environ.get('DOCKER_CONTEXT')
    if context:
        args = ['docker', 'context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']
        endpoint = checked(args, 'docker-context', budget).stdout.strip()
    elif os.environ.get('DOCKER_HOST'):
        endpoint = os.environ['DOCKER_HOST']
    else:
        args = ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']
        endpoint = checked(args, 'docker-context', budget).stdout.strip()
    if not stat.S_ISSOCK(socket_path(endpoint).stat().st_mode):
        raise Failure('docker-endpoint', 'socket_unavailable')
    return ['docker', '--host', endpoint]


def safe_scalar(value, known_strings=()):
    """Only booleans, bounded numbers and explicitly known strings may be logged."""
    if value is None or type(value) is bool:
        return value
    if type(value) is int and -(2**63) <= value < 2**63:
        return value
    if type(value) is float and -2**63 <= value < 2**63:
        return value
    if isinstance(value, str) and value in known_strings:
        return value
    return '<redacted-or-invalid-value>'


def safe_container_state(info, message):
    """Copy only typed process metadata and a fixed message, never Docker errors."""
    exit_code = info.get('exit_code')
    oom_killed = info.get('oom_killed')
    running = info.get('running')
    return {
        'Running': running if type(running) is bool else '<unavailable>',
        'ExitCode': exit_code if type(exit_code) is int and 0 <= exit_code < 2**31 else '<unavailable>',
        'OOMKilled': oom_killed if type(oom_killed) is bool else '<unavailable>',
        'message': message if message in STARTUP_MESSAGES.values() else 'startup_step_unknown',
    }


def startup_message(stdout):
    """Recognize exact fixed progress lines only; discard all other log contents."""
    message = 'startup_step_unknown'
    if not isinstance(stdout, str):
        return message
    for line in stdout.splitlines():
        if line in STARTUP_MESSAGES:
            message = STARTUP_MESSAGES[line]
    return message


def safe_collection(value):
    """Presence/count only: no host paths, volume names, addresses or map keys."""
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, str)):
        return {'type': type(value).__name__, 'entries': len(value)}
    return safe_scalar(value)


def safe_items(value, known_strings):
    if value is None:
        return None
    if not isinstance(value, (list, tuple)):
        return safe_scalar(value, known_strings)
    items = [safe_scalar(v, known_strings) for v in value[:32]]
    if len(value) > 32:
        items.append('<remaining-items-redacted>')
    return items


def safe_paths(value):
    if not isinstance(value, dict):
        return '<invalid-map>'
    # Only /tmp is a public, expected path. Do not disclose unexpected paths.
    return {'tmp_present': '/tmp' in value, 'other_paths': len(value) - int('/tmp' in value)}


def safe_tmpfs_options(value):
    if value is None:
        return '<missing>'
    if not isinstance(value, str):
        return '<invalid-options>'
    known_flags = {'rw', 'ro', 'nosuid', 'suid', 'nodev', 'dev', 'exec', 'noexec',
                   'sync', 'async', 'atime', 'noatime', 'relatime', 'dirsync', 'nodiratime'}
    result = []
    for token in value.split(',')[:32]:
        # This is output filtering ONLY; it never normalizes validation values.
        if (token in known_flags or re.fullmatch(r'size=[0-9]{1,16}[kKmMgG]?', token)
                or re.fullmatch(r'mode=[0-7]{3,5}', token)):
            result.append(token)
        else:
            result.append('<redacted-option>')
    if len(value.split(',')) > 32:
        result.append('<remaining-options-redacted>')
    return result


def safe_networks(value):
    if not isinstance(value, dict):
        return safe_collection(value)
    known = {'none', 'bridge', 'host', 'default'}
    return {'known_names': sorted(k for k in value if k in known),
            'other_networks': sum(k not in known for k in value)}


def safe_mounts(value):
    if not isinstance(value, list):
        return safe_collection(value)
    result = []
    for mount in value[:32]:
        if not isinstance(mount, dict):
            result.append('<invalid-mount>')
        else:
            result.append({'type': safe_scalar(mount.get('Type'), ('tmpfs', 'bind', 'volume')),
                           'destination': safe_scalar(mount.get('Destination'), ('/tmp',))})
    if len(value) > 32:
        result.append('<remaining-mounts-redacted>')
    return result


def isolation_mismatches(info, running):
    """Describe failed predicates without retaining arbitrary Docker values."""
    host = info['host']
    options = host.get('Tmpfs') or {}
    checks = [
        ('HostConfig.NetworkMode', host.get('NetworkMode') != 'none', 'none',
         safe_scalar(host.get('NetworkMode'), ('none', 'bridge', 'host', 'default'))),
        ('HostConfig.PortBindings', bool(host.get('PortBindings')), 'none-or-empty', safe_collection(host.get('PortBindings'))),
        ('HostConfig.PublishAllPorts', bool(host.get('PublishAllPorts')), False, safe_scalar(host.get('PublishAllPorts'))),
        ('HostConfig.Binds', bool(host.get('Binds')), 'none-or-empty', safe_collection(host.get('Binds'))),
        ('HostConfig.VolumesFrom', bool(host.get('VolumesFrom')), 'none-or-empty', safe_collection(host.get('VolumesFrom'))),
        ('Config.User', info['user'] != 'postgres', 'postgres', safe_scalar(info['user'], ('postgres', 'root', '0'))),
        ('HostConfig.Privileged', bool(host.get('Privileged')), False, safe_scalar(host.get('Privileged'))),
        ('HostConfig.ReadonlyRootfs', not host.get('ReadonlyRootfs'), True, safe_scalar(host.get('ReadonlyRootfs'))),
        ('HostConfig.CapAdd', bool(host.get('CapAdd')), 'none-or-empty',
         safe_items(host.get('CapAdd'), ('ALL', 'CAP_ALL', 'SYS_ADMIN', 'CAP_SYS_ADMIN', 'NET_ADMIN', 'CAP_NET_ADMIN'))),
        ('HostConfig.CapDrop', 'ALL' not in (host.get('CapDrop') or []), 'contains-exact-ALL',
         safe_items(host.get('CapDrop'), ('ALL', 'CAP_ALL'))),
        ('HostConfig.SecurityOpt', not any(x in ('no-new-privileges', 'no-new-privileges=true')
           for x in (host.get('SecurityOpt') or [])), 'contains-no-new-privileges-or-no-new-privileges=true',
         safe_items(host.get('SecurityOpt'), ('no-new-privileges', 'no-new-privileges=true', 'no-new-privileges=false', 'seccomp=unconfined'))),
        ('HostConfig.NanoCpus', host.get('NanoCpus') != CPU_NANO, CPU_NANO, safe_scalar(host.get('NanoCpus'))),
        ('HostConfig.Memory', host.get('Memory') != MEMORY, MEMORY, safe_scalar(host.get('Memory'))),
        ('HostConfig.MemorySwap', host.get('MemorySwap') != MEMORY, MEMORY, safe_scalar(host.get('MemorySwap'))),
        ('HostConfig.PidsLimit', host.get('PidsLimit') != PIDS, PIDS, safe_scalar(host.get('PidsLimit'))),
        ('HostConfig.Tmpfs.paths', set(options) != {'/tmp'}, {'tmp_present': True, 'other_paths': 0}, safe_paths(options)),
        ('HostConfig.Tmpfs.options', '/tmp' not in options or set(options['/tmp'].split(',')) != set(TMPFS.split(',')),
         TMPFS.split(','), safe_tmpfs_options(options.get('/tmp'))),
        ('Mounts', any(m['Type'] != 'tmpfs' or m['Destination'] != '/tmp' for m in info['mounts']),
         'only-tmpfs-at-/tmp-or-empty', safe_mounts(info['mounts'])),
        ('NetworkSettings.Ports', any(bindings for bindings in (info['ports'] or {}).values()),
         'no-host-bindings', safe_collection(info['ports'])),
        ('NetworkSettings.Networks.allowed', bool(set(info['networks'] or {}) - {'none'}),
         'empty-or-only-none', safe_networks(info['networks'])),
    ]
    if running:
        checks += [
            ('NetworkSettings.Networks.ready', set(info['networks'] or {}) != {'none'},
             'exactly-none', safe_networks(info['networks'])),
        ]
    return tuple({'item': item, 'expected': expected, 'actual': actual}
                 for item, failed, expected, actual in checks if failed)


def validate_isolation(info, running=False, *, phase=None):
    # Only configuration/network checks here. check_running separately rejects
    # an exited process and reports its exit metadata before allowing any SQL.
    host = info['host']
    options = host.get('Tmpfs') or {}
    if (host.get('NetworkMode') != 'none' or host.get('PortBindings')
            or host.get('PublishAllPorts') or host.get('Binds') or host.get('VolumesFrom')
            or info['user'] != 'postgres' or host.get('Privileged')
            or not host.get('ReadonlyRootfs') or host.get('CapAdd')
            or 'ALL' not in (host.get('CapDrop') or [])
            or not any(x in ('no-new-privileges', 'no-new-privileges=true')
                       for x in (host.get('SecurityOpt') or []))
            or host.get('NanoCpus') != CPU_NANO or host.get('Memory') != MEMORY
            or host.get('MemorySwap') != MEMORY or host.get('PidsLimit') != PIDS
            or set(options) != {'/tmp'} or set(options['/tmp'].split(',')) != set(TMPFS.split(','))
            or any(m['Type'] != 'tmpfs' or m['Destination'] != '/tmp' for m in info['mounts'])
            or any(bindings for bindings in (info['ports'] or {}).values())
            or set(info['networks'] or {}) - {'none'}
            or (running and set(info['networks'] or {}) != {'none'})):
        try:
            mismatches = isolation_mismatches(info, running)
        except Exception:
            # Diagnostic errors must never bypass rejection or echo raw values.
            mismatches = ({'item': 'diagnostics', 'expected': 'readable-isolation-fields',
                           'actual': 'unavailable-values-suppressed'},)
        raise Failure('isolation', 'unexpected_container_settings', phase=phase, mismatches=mismatches)


def create_arguments(name, nonce, image_id):
    # BusyBox timeout also bounds the DB lifetime if the Python client disappears.
    # If it is unavailable in the cached image, startup fails without a fallback.
    # Only these fixed markers reach Docker logs. Keep process output in tmpfs.
    # Preserve initdb's exit status; exec preserves the server's exit status.
    server = (
        "printf '%s\\n' '" + INITDB_STARTED + "'\n"
        "if initdb -D /tmp/movie-access-pg -U bootstrap -A trust --locale=C --encoding=UTF8 "
        ">/tmp/initdb.log 2>&1; then\n"
        "  printf '%s\\n' '" + POSTGRES_STARTING + "'\n"
        "  exec postgres -D /tmp/movie-access-pg -k /tmp "
        "-c listen_addresses='' -c log_statement=none -c log_min_error_statement=panic "
        "-c statement_timeout=10000 -c lock_timeout=2000 "
        "-c idle_in_transaction_session_timeout=15000 >/tmp/postgres.log 2>&1\n"
        "else\n"
        "  initdb_status=$?\n"
        "  printf '%s\\n' '" + INITDB_FAILED + "'\n"
        '  exit "$initdb_status"\n'
        "fi"
    )
    return ['create', '--pull', 'never', '--name', name,
            '--label', 'movie-log-access-test=' + nonce, '--network', 'none',
            '--user', 'postgres', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges=true', '--cpus', '1',
            '--memory', str(MEMORY), '--memory-swap', str(MEMORY), '--pids-limit', str(PIDS),
            '--entrypoint', '/bin/sh', '--tmpfs', '/tmp:' + TMPFS, image_id, '-c',
            'exec timeout -s TERM -k 5 ' + str(PATTERN_SECONDS) + ' /bin/sh -c '
            + "'" + server.replace("'", "'\"'\"'") + "'"]


def steps_for(case):
    steps = [Step('fixture', 'bootstrap.sql', 'bootstrap'),
             Step('defaults', 'broad' if case.broad else 'restricted', 'bootstrap')]
    steps += [Step('migration', name, 'postgres') for name in ORIGINALS]
    if case.upgrade:
        steps += [Step('fixture', name, 'bootstrap')
                  for name in ('seed.sql', 'inject_legacy.sql', 'prepare.sql')]
    steps.append(Step('migration', MIGRATION, 'postgres'))
    if not case.upgrade:
        steps += [Step('fixture', name, 'bootstrap') for name in ('seed.sql', 'prepare.sql')]
    steps += [Step('assertions', name, 'bootstrap') for name in ('catalog.test.sql', 'access.test.sql')]
    return steps


def source_for(step):
    if step.kind == 'defaults':
        if step.name == 'restricted':
            return '-- PostgreSQL PUBLIC function default remains, as on new Supabase projects.\n'
        return ('ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES TO anon,authenticated,service_role;\n'
                'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;\n')
    directory = ROOT / 'supabase/migrations' if step.kind == 'migration' else HERE
    return (directory / step.name).read_text()


def file_checks():
    for name, digest in ORIGINALS.items():
        if hashlib.sha256((ROOT / 'supabase/migrations' / name).read_bytes()).hexdigest() != digest:
            raise Failure('files:' + name, 'original_migration_changed')
    added = (ROOT / 'supabase/migrations' / MIGRATION).read_text()
    count = 0
    for name in ORIGINALS:
        source = (ROOT / 'supabase/migrations' / name).read_text()
        for match in re.finditer(r'CREATE OR REPLACE FUNCTION public\.((?:create|update|delete)_movie_log_with_series_order)\(([^\n]*)\)', source):
            types = [re.split(r'\s+DEFAULT\s+', part, flags=re.I)[0].strip().split(' ', 1)[1]
                     for part in match[2].split(',')]
            if 'public.' + match[1] + '(' + ', '.join(types) + ')' not in added:
                raise Failure('files:rpc-signatures', 'signature_mismatch')
            count += 1
    if count != 3:
        raise Failure('files:rpc-signatures', 'expected_three_rpcs')
    for path in HERE.glob('*.py'):
        ast.parse(path.read_text(), filename=str(path))
    for case in CASES:
        steps = steps_for(case)
        if tuple(s.name for s in steps if s.kind == 'migration') != MIGRATIONS:
            raise Failure('files:plan', 'incorrect_migration_order')
        for step in steps:
            source_for(step)
    print('PASS offline checks: original hashes, RPC signatures, Python syntax, four plans and fixture files')
    print('SQL execution, SQL syntax, privileges and RLS have NOT been tested.')


class Disposable:
    def __init__(self, docker, case, image_id, parent):
        self.docker, self.case, self.image_id = docker, case, image_id
        self.nonce = uuid.uuid4().hex
        self.name = 'movie-log-movie-access-test-' + self.nonce[:12]
        self.id, self.attempted = None, False
        self.budget = Budget(PATTERN_SECONDS, parent)

    def call(self, args, stage, **kwargs):
        return checked(self.docker + args, stage, self.budget, **kwargs)

    def inspect(self):
        result = self.call(['inspect', self.id or self.name, '--format', INSPECT_FORMAT], 'inspect')
        info = json.loads(result.stdout)
        if (info['label'] != self.nonce or info['name'] != '/' + self.name
                or (self.id is not None and info['id'] != self.id)):
            raise Failure('inspect', 'container_identity_mismatch')
        return info

    def sql(self, source, stage, user='bootstrap', allow_failure=False):
        return self.call(['exec', '-i', self.id, 'psql', '-X', '-w', '-q', '-t', '-A',
                          '-h', '/tmp', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                          '-v', 'VERBOSITY=verbose'], stage, source=source,
                         timeout=15, allow_failure=allow_failure)

    def stopped_failure(self, info, phase):
        message = 'startup_step_unknown'
        try:
            # Read only this identity-checked container, with a bounded command.
            # Raw stdout/stderr never enters Failure or report_failure.
            logs = self.call(['logs', '--tail', '16', self.id], 'startup-diagnostics',
                             allow_failure=True, timeout=5)
            if logs.returncode == 0:
                message = startup_message(logs.stdout)
        except Failure:
            # A missing log/expired budget must not mask the exit or skip cleanup.
            pass
        stage = 'container-startup' if phase == 'post-start' else 'container-runtime'
        reason = 'container_exited' if info.get('running') is False else 'container_state_unavailable'
        return Failure(stage, reason, phase=phase, container_state=info, startup_message=message)

    def check_running(self, phase):
        info = self.inspect()
        # Configuration violations take priority, even if the process also exited.
        # A stopped container may lose its runtime network attachment; no SQL may
        # follow that state. A live container must still have exactly network none.
        validate_isolation(info, running=info.get('running') is True, phase=phase)
        if info.get('running') is not True:
            raise self.stopped_failure(info, phase)

    def start(self):
        self.attempted = True
        result = self.call(create_arguments(self.name, self.nonce, self.image_id), 'create')
        container_id = result.stdout.strip()
        if not re.fullmatch('[0-9a-f]{64}', container_id):
            raise Failure('create', 'invalid_container_id')
        self.id = container_id
        validate_isolation(self.inspect(), phase='pre-start')
        try:
            started = self.call(['start', self.id], 'start', allow_failure=True)
        except Failure as error:
            raise Failure('container-startup', error.reason, phase='post-start') from None
        if started.returncode:
            raise Failure('container-startup', 'docker_start_failed', phase='post-start')
        startup_end = time.monotonic() + self.budget.timeout('startup', 60)
        while time.monotonic() < startup_end:
            self.check_running('post-start')
            if self.sql('SELECT 1;', 'readiness', allow_failure=True).returncode == 0:
                break
            time.sleep(.2)
        else:
            raise Failure('startup', 'startup_timeout')
        identity = self.sql("SELECT current_user='bootstrap' AND current_database()='postgres' "
                            "AND inet_server_addr() IS NULL AND current_setting('listen_addresses')='';",
                            'database-identity')
        if identity.stdout.strip() != 't':
            raise Failure('database-identity', 'unexpected_database')

    def execute(self):
        self.start()
        for step in steps_for(self.case):
            stage = step.kind + ':' + step.name
            print('STEP pattern=' + self.case.name + ' stage=' + stage, flush=True)
            result = self.sql(source_for(step), stage, user=step.user)
            if step.kind == 'assertions':
                # Count notices, never echo DB text, parameters or error context.
                passed = len(re.findall(r'NOTICE:\s+(?:00000:\s+)?PASS ', result.stderr))
                if not passed:
                    raise Failure(stage, 'no_assertions_reported')
                print('PASS pattern=' + self.case.name + ' file=' + step.name + ' checks=' + str(passed))
        self.check_running('post-tests')

    def cleanup(self):
        if not self.attempted:
            return
        # Separate allowance: an expired test deadline must not skip cleanup.
        budget = Budget(CLEANUP_SECONDS)
        result = checked(self.docker + ['inspect', self.id or self.name, '--format', INSPECT_FORMAT],
                         'cleanup-inspect', budget, allow_failure=True)
        if result.returncode:
            if 'No such object' in result.stderr or 'No such container' in result.stderr:
                return
            raise Failure('cleanup-inspect', 'cannot_confirm_container_identity')
        info = json.loads(result.stdout)
        if (info['label'] != self.nonce or info['name'] != '/' + self.name
                or not re.fullmatch('[0-9a-f]{64}', info['id'])
                or (self.id is not None and info['id'] != self.id)):
            raise Failure('cleanup-inspect', 'refusing_unowned_container')
        # No -v, volume rm, prune, VolumesFrom or name wildcards. tmpfs only.
        checked(self.docker + ['rm', '--force', info['id']], 'cleanup-remove', budget)
        left = checked(self.docker + ['ps', '-aq', '--no-trunc', '--filter', 'id=' + info['id']],
                       'cleanup-confirm', budget)
        if left.stdout.strip():
            raise Failure('cleanup-confirm', 'test_container_remains')
        print('CLEAN pattern=' + self.case.name + ' own_container_removed', flush=True)


def run_pattern(docker, case, image_id, budget):
    test = Disposable(docker, case, image_id, budget)
    failure = None
    try:
        test.execute()
    except BaseException as error:
        failure = error if isinstance(error, Failure) else Failure('pattern', 'interrupted_or_unexpected_error')
    try:
        test.cleanup()
    except BaseException as error:
        cleanup_error = error if isinstance(error, Failure) else Failure('cleanup', 'unexpected_cleanup_error')
        if failure is not None:
            report_failure(failure, case.name)
        failure = cleanup_error
    if failure is not None:
        raise failure


def run_db_tests():
    budget = Budget(SUITE_SECONDS)
    docker = local_docker(budget)
    template = '{"id":{{json .Id}},"volumes":{{json (index .Config "Volumes")}}}'
    result = checked(docker + ['image', 'inspect', IMAGE, '--format', template],
                     'image-inspect', budget, allow_failure=True)
    if result.returncode:
        print('SKIP cached image unavailable; no download or DB execution attempted.')
        return 2
    image = json.loads(result.stdout)
    if image['volumes'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']):
        raise Failure('image-inspect', 'image_declares_volumes_or_invalid_identity')
    previous_handler = signal.getsignal(signal.SIGTERM)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        for case in CASES:
            try:
                run_pattern(docker, case, image['id'], budget)
            except Failure as error:
                report_failure(error, case.name)
                return 1
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
    print('PASS all four disposable PostgreSQL patterns; real Supabase Auth/Google not tested.')
    return 0


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        # Accidental --db-url may contain credentials: never echo argv.
        print('Invalid arguments: only --run-disposable-db is accepted; values suppressed.', file=sys.stderr)
        raise SystemExit(2)


def main(argv=None):
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument('--run-disposable-db', action='store_true',
                        help='Explicit opt-in: execute SQL only in four new isolated containers')
    args = parser.parse_args(argv)
    file_checks()
    return run_db_tests() if args.run_disposable_db else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        report_failure(error)
        sys.exit(1)
