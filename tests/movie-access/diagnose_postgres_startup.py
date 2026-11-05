#!/usr/bin/env python3
"""Independent PostgreSQL startup probe; default mode is static checks only.

--run-disposable-db opts into ONE new disposable container, no SQL/migrations.
Reuse only run.py's local endpoint, isolation, resource limits and owned cleanup.
Bypass its startup wrapper, BusyBox timeout, readiness SQL and migration executor.
Output is restricted to fixed stage names, PASS/FAIL and numeric/unknown codes.
The code is a Docker command/probe exit code, not a guessed PostgreSQL error.
"""
import ast
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import signal
import sys

_spec = importlib.util.spec_from_file_location('postgres_diagnostic_safety', Path(__file__).with_name('run.py'))
safety = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(safety)

# No image entrypoint, shell profiles, extra mounts or host environment values.
# The independent keeper expires even if this Python process disappears.
KEEPER = ('diag_ticks=0; while [ "$diag_ticks" -lt ' + str(safety.PATTERN_SECONDS) + ' ]; do '
          'sleep 1 || exit "$?"; diag_ticks=$((diag_ticks + 1)); done')
PROBES = (
    ('postgres-user',
     'diag_user=$(id -un 2>/dev/null); diag_rc=$?; '
     '[ "$diag_rc" -eq 0 ] || exit "$diag_rc"; [ "$diag_user" = postgres ]', 20),
    ('initdb-command', 'command -v initdb >/dev/null 2>&1 && initdb --version >/dev/null 2>&1', 20),
    ('postgres-command', 'command -v postgres >/dev/null 2>&1 && postgres --version >/dev/null 2>&1', 20),
    ('tmp-write',
     'umask 077; printf x >/tmp/movie-access-diag-write && '
     '[ "$(cat /tmp/movie-access-diag-write)" = x ] && rm /tmp/movie-access-diag-write', 20),
    ('initdb', 'initdb -D /tmp/movie-access-pg -U bootstrap -A trust --locale=C --encoding=UTF8 '
     '>/tmp/initdb.log 2>&1', 60),
    ('readiness-command', 'command -v pg_isready >/dev/null 2>&1 && pg_isready --version >/dev/null 2>&1', 20),
    ('postgres-server', r'''
postgres -D /tmp/movie-access-pg -k /tmp \
  -c listen_addresses='' -c log_statement=none -c log_min_error_statement=panic \
  -c statement_timeout=10000 -c lock_timeout=2000 \
  -c idle_in_transaction_session_timeout=15000 \
  </dev/null >/tmp/postgres.log 2>&1 &
diag_pid=$!
diag_attempt=0
while [ "$diag_attempt" -lt 25 ]; do
  if ! kill -0 "$diag_pid" 2>/dev/null; then
    wait "$diag_pid"
    diag_rc=$?
    [ "$diag_rc" -ne 0 ] && exit "$diag_rc"
    exit 1
  fi
  if pg_isready -q -h /tmp -p 5432 -U bootstrap -d postgres -t 1 >/dev/null 2>&1; then
    kill -0 "$diag_pid" 2>/dev/null
    exit "$?"
  fi
  sleep 1 || exit "$?"
  diag_attempt=$((diag_attempt + 1))
done
kill "$diag_pid" 2>/dev/null
exit 124
''', 60),
)
STAGES = {'static-check', 'arguments', 'docker-local', 'cached-image', 'container-create',
          'container-start', 'isolation-pre-start', 'isolation-running', 'container-running',
          'cleanup', 'diagnostic'} | {p[0] for p in PROBES}


class DiagnosticFailure(Exception):
    def __init__(self, stage, code=None):
        self.stage, self.code = stage, code
        super().__init__('Details suppressed')


def emit(stage, passed, code=None):
    stage = stage if stage in STAGES else 'diagnostic'
    code = str(code) if type(code) is int and 0 <= code < 2**31 else 'unknown'
    print('stage=' + stage + ' status=' + ('PASS' if passed else 'FAIL') + ' exit_code=' + code, flush=True)


def require_result(stage, response):
    if response.returncode:
        raise DiagnosticFailure(stage, response.returncode)


class StartupDiagnostic:
    def __init__(self, docker, image_id, budget):
        self.container = safety.Disposable(docker, safety.CASES[0], image_id, budget)
        self.container.name = 'movie-log-postgres-startup-diag-' + self.container.nonce[:12]
        self.stage = 'container-create'

    def isolation(self, running=False):
        self.stage = 'isolation-running' if running else 'isolation-pre-start'
        info = self.container.inspect()  # Checks nonce, exact ID and name.
        safety.validate_isolation(info, running=running and info.get('running') is True)
        if running and info.get('running') is not True:
            raise DiagnosticFailure('container-running', info.get('exit_code'))

    def execute(self):
        test = self.container
        # All resource/isolation flags are identical; replace only PID 1's script.
        args = safety.create_arguments(test.name, test.nonce, test.image_id)
        args[-1] = KEEPER
        test.attempted = True
        response = test.call(args, self.stage, allow_failure=True)
        require_result(self.stage, response)
        container_id = response.stdout.strip()
        if not re.fullmatch('[0-9a-f]{64}', container_id):
            raise DiagnosticFailure(self.stage)
        test.id = container_id
        emit(self.stage, True, 0)
        self.isolation()
        emit(self.stage, True, 0)
        self.stage = 'container-start'
        require_result(self.stage, test.call(['start', test.id], self.stage, allow_failure=True))
        emit(self.stage, True, 0)
        for stage, script, seconds in PROBES:
            self.isolation(running=True)
            self.stage = stage
            # No source is read from the host; stdout/stderr are captured, never printed.
            response = test.call(['exec', test.id, '/bin/sh', '-c', script], stage,
                                 allow_failure=True, timeout=seconds)
            require_result(stage, response)
            emit(stage, True, 0)
        self.isolation(running=True)

    def cleanup(self):
        # Reuse exact-ID/name/nonce confirmation, independent cleanup budget, no -v.
        # Suppress the old runner's different output format.
        with contextlib.redirect_stdout(io.StringIO()):
            self.container.cleanup()


def run_diagnostic():
    stage, diagnostic, code = 'docker-local', None, 0
    budget = safety.Budget(safety.PATTERN_SECONDS)
    previous = signal.getsignal(signal.SIGTERM)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        docker = safety.local_docker(budget)
        emit(stage, True, 0)
        stage = 'cached-image'
        template = '{"id":{{json .Id}},"volumes":{{json (index .Config "Volumes")}}}'
        response = safety.checked(docker + ['image', 'inspect', safety.IMAGE, '--format', template],
                                  stage, budget, allow_failure=True)
        require_result(stage, response)
        image = json.loads(response.stdout)
        if image['volumes'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']):
            raise DiagnosticFailure(stage)
        emit(stage, True, 0)
        diagnostic = StartupDiagnostic(docker, image['id'], budget)
        diagnostic.execute()
    except DiagnosticFailure as error:
        emit(error.stage, False, error.code)
        code = 1
    except (Exception, KeyboardInterrupt):
        emit(diagnostic.stage if diagnostic is not None else stage, False)
        code = 1
    finally:
        try:
            if diagnostic is not None:
                try:
                    diagnostic.cleanup()
                except BaseException:
                    emit('cleanup', False)
                    code = 1
                else:
                    emit('cleanup', True, 0)
        finally:
            signal.signal(signal.SIGTERM, previous)
    return code


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ['--run-disposable-db']:
        return run_diagnostic()
    if argv:
        emit('arguments', False, 2)
        return 2
    # Default never touches Docker or an endpoint, nor reads migrations/settings.
    ast.parse(Path(__file__).read_text())
    emit('static-check', True, 0)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt):
        emit('diagnostic', False)
        sys.exit(1)
