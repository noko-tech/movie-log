"""Offline orchestration/safety tests. Every external command is blocked or mocked."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('movie_access_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
ORIGINAL_COMMAND = runner.command
IMAGE_ID = 'sha256:' + 'b' * 64
CONTAINER_ID = 'a' * 64


def result(stdout='', stderr='', code=0):
    return subprocess.CompletedProcess(['mock-only'], code, stdout, stderr)


def good_info():
    return {'id': CONTAINER_ID, 'name': '/unused', 'label': 'unused',
            'user': 'postgres', 'running': True, 'exit_code': 0, 'oom_killed': False, 'mounts': [],
            'networks': {'none': {}}, 'ports': {'5432/tcp': None},
            'host': {'NetworkMode': 'none', 'PortBindings': None, 'PublishAllPorts': False,
                     'Binds': None, 'VolumesFrom': None, 'Privileged': False,
                     'ReadonlyRootfs': True, 'CapAdd': None, 'CapDrop': ['ALL'],
                     'SecurityOpt': ['no-new-privileges=true'], 'NanoCpus': runner.CPU_NANO,
                     'Memory': runner.MEMORY, 'MemorySwap': runner.MEMORY,
                     'PidsLimit': runner.PIDS, 'Tmpfs': {'/tmp': runner.TMPFS}}}


class RunnerSafetyTests(unittest.TestCase):
    def setUp(self):
        # A missed mock must fail, never invoke Docker/psql/network as a side effect.
        self.command_guard = patch.object(runner, 'command', side_effect=AssertionError('External command forbidden'))
        self.command_guard.start()
        self.addCleanup(self.command_guard.stop)

    def disposable(self):
        test = runner.Disposable(['docker', '--host', 'unix:///tmp/mock.sock'],
                                 runner.CASES[0], IMAGE_ID, runner.Budget(1200))
        test.id, test.attempted = CONTAINER_ID, True
        return test

    def owned_info(self, test):
        info = good_info()
        info.update(name='/' + test.name, label=test.nonce)
        return info

    def test_default_mode_cannot_run_db(self):
        with patch.object(runner, 'run_db_tests', side_effect=AssertionError('DB forbidden')), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main([]), 0)

    def test_db_mode_requires_explicit_flag(self):
        with patch.object(runner, 'file_checks'), patch.object(runner, 'run_db_tests', return_value=7) as db:
            self.assertEqual(runner.main(['--run-disposable-db']), 7)
            db.assert_called_once_with()

    def test_bad_arguments_never_echo_secret_values(self):
        for args in [['--db-url', 'postgresql://user:DO_NOT_ECHO@example.invalid/db'],
                     ['--container', 'DO_NOT_ECHO'], ['--linked', 'DO_NOT_ECHO']]:
            out = io.StringIO()
            with self.subTest(args=args), contextlib.redirect_stderr(out), self.assertRaises(SystemExit):
                runner.main(args)
            self.assertNotIn('DO_NOT_ECHO', out.getvalue())
            self.assertNotIn('postgresql://', out.getvalue())

    def test_four_distinct_patterns_and_exact_migration_order(self):
        self.assertEqual({(c.upgrade, c.broad) for c in runner.CASES},
                         {(False, False), (False, True), (True, False), (True, True)})
        self.assertEqual(len({c.name for c in runner.CASES}), 4)
        for case in runner.CASES:
            steps = runner.steps_for(case)
            migrations = [s for s in steps if s.kind == 'migration']
            self.assertEqual(tuple(s.name for s in migrations), runner.MIGRATIONS)
            self.assertTrue(all(s.user == 'postgres' for s in migrations))
            self.assertEqual([s.name for s in steps[-2:]], ['catalog.test.sql', 'access.test.sql'])

    def test_fresh_installs_all_five_before_any_seed_or_fault_injection(self):
        for case in runner.CASES[:2]:
            steps = runner.steps_for(case)
            last = next(i for i, s in enumerate(steps) if s.name == runner.MIGRATION)
            positions = [i for i, s in enumerate(steps) if s.kind == 'migration']
            self.assertEqual(positions, list(range(positions[0], last + 1)))
            self.assertNotIn('inject_legacy.sql', [s.name for s in steps])
            self.assertGreater(next(i for i, s in enumerate(steps) if s.name == 'seed.sql'), last)

    def test_upgrade_preserves_existing_data_before_fifth_migration(self):
        for case in runner.CASES[2:]:
            names = [s.name for s in runner.steps_for(case)]
            self.assertLess(names.index('seed.sql'), names.index('inject_legacy.sql'))
            self.assertLess(names.index('inject_legacy.sql'), names.index('prepare.sql'))
            self.assertLess(names.index('prepare.sql'), names.index(runner.MIGRATION))

    def test_remote_docker_endpoints_are_rejected(self):
        for endpoint in ['tcp://127.0.0.1:2375', 'ssh://example.invalid', 'https://example.invalid',
                         'unix://remote/tmp/docker.sock', 'unix:relative.sock',
                         'unix:///tmp/docker.sock?override=remote']:
            with self.subTest(endpoint=endpoint), self.assertRaises(runner.Failure):
                runner.socket_path(endpoint)
        self.assertEqual(runner.socket_path('unix:///tmp/docker.sock'), Path('/tmp/docker.sock'))

    def test_isolation_rejects_network_ports_mounts_privilege_and_unbounded_resources(self):
        runner.validate_isolation(good_info(), running=True)
        bad_host = [('NetworkMode', 'host'), ('PortBindings', {'5432/tcp': []}),
                    ('PublishAllPorts', True), ('Binds', ['/existing:/data']),
                    ('VolumesFrom', ['existing']), ('Privileged', True),
                    ('ReadonlyRootfs', False), ('CapDrop', []), ('CapAdd', ['SYS_ADMIN']),
                    ('SecurityOpt', []), ('NanoCpus', 0), ('Memory', 0), ('MemorySwap', -1),
                    ('PidsLimit', 0), ('Tmpfs', {'/tmp': 'rw,mode=1777'})]
        for key, value in bad_host:
            bad = copy.deepcopy(good_info()); bad['host'][key] = value
            with self.subTest(key=key), self.assertRaises(runner.Failure):
                runner.validate_isolation(bad)
        for key, value in [('user', 'root'), ('mounts', [{'Type': 'bind', 'Destination': '/tmp'}]),
                           ('mounts', [{'Type': 'volume', 'Destination': '/data'}]),
                           ('ports', {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '12345'}]}),
                           ('networks', {'none': {}, 'bridge': {}})]:
            bad = copy.deepcopy(good_info()); bad[key] = value
            with self.subTest(key=key), self.assertRaises(runner.Failure):
                runner.validate_isolation(bad)

    def test_running_check_requires_actual_running_none_network(self):
        for values in [{'running': False}, {'networks': {}}]:
            test = self.disposable()
            with self.subTest(values=values), \
                    patch.object(test, 'inspect', return_value=dict(good_info(), **values)), \
                    patch.object(test, 'call', return_value=result()), self.assertRaises(runner.Failure):
                test.check_running('post-start')

    def test_create_arguments_have_limits_no_shares_and_no_pull(self):
        args = runner.create_arguments('test-name', 'nonce', IMAGE_ID)
        for flag, value in [('--network', 'none'), ('--pull', 'never'), ('--cpus', '1'),
                            ('--memory', str(runner.MEMORY)), ('--memory-swap', str(runner.MEMORY)),
                            ('--pids-limit', str(runner.PIDS))]:
            self.assertEqual(args[args.index(flag) + 1], value)
        for forbidden in ['--publish', '-p', '--volume', '-v', '--volumes-from', '--mount']:
            self.assertNotIn(forbidden, args)
        self.assertIn(IMAGE_ID, args)
        shell = shlex.split(args[-1])
        self.assertEqual(shell[:9], ['exec', 'timeout', '-s', 'TERM', '-k', '5',
                                     '240', '/bin/sh', '-c'])
        self.assertIn("listen_addresses=''", shell[-1])
        self.assertIn('statement_timeout=10000', shell[-1])

    def test_invalid_isolation_prevents_container_start_and_sql(self):
        test = self.disposable()
        bad = good_info(); bad['host']['NetworkMode'] = 'host'
        with patch.object(test, 'call', return_value=result(CONTAINER_ID)) as call, \
                patch.object(test, 'inspect', return_value=bad), \
                patch.object(test, 'sql', side_effect=AssertionError('SQL forbidden')), \
                self.assertRaises(runner.Failure):
            test.start()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args[0][0][0], 'create')

    def test_budget_caps_parent_and_each_command(self):
        with patch.object(runner.time, 'monotonic', return_value=100):
            parent = runner.Budget(10); child = runner.Budget(20, parent)
        with patch.object(runner.time, 'monotonic', return_value=105):
            self.assertEqual(child.timeout('test', 30), 5)
        with patch.object(runner.time, 'monotonic', return_value=111), self.assertRaises(runner.Failure):
            child.timeout('test')

    def test_migration_failure_stops_before_later_migrations(self):
        test = self.disposable()
        failed_name = runner.MIGRATIONS[2]
        seen = []
        def mocked_sql(_source, stage, **_kwargs):
            seen.append(stage)
            if stage == 'migration:' + failed_name:
                raise runner.Failure(stage, 'command_or_sql_error', '42501')
            return result()
        with patch.object(test, 'start'), patch.object(test, 'sql', side_effect=mocked_sql), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(runner.Failure):
            test.execute()
        self.assertEqual([s for s in seen if s.startswith('migration:')],
                         ['migration:' + n for n in runner.MIGRATIONS[:3]])

    def test_failure_and_interrupt_still_call_cleanup(self):
        for error in [runner.Failure('test', 'sql_error'), KeyboardInterrupt()]:
            test = Mock(); test.execute.side_effect = error
            with patch.object(runner, 'Disposable', return_value=test), self.assertRaises(runner.Failure):
                runner.run_pattern([], runner.CASES[0], IMAGE_ID, runner.Budget(10))
            test.cleanup.assert_called_once_with()

    def test_cleanup_refuses_changed_label_id_or_name(self):
        for key, value in [('label', 'someone-else'), ('id', 'f' * 64), ('name', '/existing')]:
            test = self.disposable(); info = self.owned_info(test); info[key] = value
            with patch.object(runner, 'command', return_value=result(json.dumps(info))) as cmd, \
                    self.assertRaises(runner.Failure):
                test.cleanup()
            self.assertEqual(cmd.call_count, 1)
            self.assertNotIn('rm', cmd.call_args[0][0])

    def test_cleanup_removes_exact_id_without_deleting_volumes_even_after_deadline(self):
        test = self.disposable(); test.budget.end = -1
        replies = [result(json.dumps(self.owned_info(test))), result(), result()]
        with patch.object(runner, 'command', side_effect=replies) as cmd, \
                contextlib.redirect_stdout(io.StringIO()):
            test.cleanup()
        removal = cmd.call_args_list[1][0][0]
        self.assertEqual(removal[-3:], ['rm', '--force', CONTAINER_ID])
        self.assertNotIn('-v', removal)
        self.assertTrue(all(c[0][2] > 0 for c in cmd.call_args_list))

    def test_partial_create_is_cleaned_only_after_identity_confirmation(self):
        test = self.disposable(); test.id = None
        with patch.object(runner, 'command', side_effect=[
                result(json.dumps(self.owned_info(test))), result(), result()]) as cmd, \
                contextlib.redirect_stdout(io.StringIO()):
            test.cleanup()
        self.assertEqual(cmd.call_args_list[1][0][0][-1], CONTAINER_ID)

    def test_sql_and_timeout_errors_never_print_raw_secrets(self):
        examples = [result(stderr='ERROR: 42501: DO_NOT_ECHO_PASSWORD', code=3),
                    subprocess.TimeoutExpired(['DO_NOT_ECHO_PASSWORD'], 1,
                                              output='DO_NOT_ECHO_KEY', stderr='DO_NOT_ECHO_TOKEN')]
        for item in examples:
            output = io.StringIO()
            with patch.object(runner, 'command') as cmd:
                if isinstance(item, Exception): cmd.side_effect = item
                else: cmd.return_value = item
                try:
                    runner.checked(['mock'], 'migration:fixture.sql', runner.Budget(10))
                except runner.Failure as error:
                    with contextlib.redirect_stderr(output): runner.report_failure(error)
                else: self.fail('Expected failure')
            self.assertNotIn('DO_NOT_ECHO', output.getvalue())
            self.assertIn('migration:fixture.sql', output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stderr(output): runner.report_failure(ValueError('DO_NOT_ECHO_PASSWORD'))
        self.assertNotIn('DO_NOT_ECHO', output.getvalue())

    def test_command_does_not_forward_database_credentials(self):
        with patch.dict(runner.os.environ, {'PGPASSWORD': 'DO_NOT_FORWARD',
                                          'SUPABASE_ACCESS_TOKEN': 'DO_NOT_FORWARD'}), \
                patch.object(runner.subprocess, 'run', return_value=result()) as process:
            ORIGINAL_COMMAND(['mock-only'])
        self.assertNotIn('PGPASSWORD', process.call_args[1]['env'])
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', process.call_args[1]['env'])
        self.assertTrue(process.call_args[1]['capture_output'])

    def run_mocked_suite(self, fail=False):
        image = result(json.dumps({'id': IMAGE_ID, 'volumes': None}))
        with patch.object(runner, 'local_docker', return_value=['docker']), \
                patch.object(runner, 'checked', return_value=image), \
                patch.object(runner.signal, 'signal'), patch.object(runner.signal, 'getsignal'), \
                patch.object(runner, 'run_pattern') as pattern, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if fail: pattern.side_effect = runner.Failure('migration:test.sql', 'sql_error')
            code = runner.run_db_tests()
        return code, pattern

    def test_suite_failure_does_not_start_next_pattern(self):
        code, pattern = self.run_mocked_suite(fail=True)
        self.assertEqual(code, 1); self.assertEqual(pattern.call_count, 1)

    def test_suite_visits_exactly_four_patterns_sequentially(self):
        code, pattern = self.run_mocked_suite()
        self.assertEqual(code, 0)
        self.assertEqual([c[0][1] for c in pattern.call_args_list], list(runner.CASES))
        self.assertTrue(all(c[0][2] == IMAGE_ID for c in pattern.call_args_list))

    def test_image_with_declared_volume_is_rejected_before_create(self):
        image = result(json.dumps({'id': IMAGE_ID, 'volumes': {'/existing': {}}}))
        with patch.object(runner, 'local_docker', return_value=['docker']), \
                patch.object(runner, 'checked', return_value=image), \
                patch.object(runner, 'run_pattern') as pattern, self.assertRaises(runner.Failure):
            runner.run_db_tests()
        pattern.assert_not_called()

    def test_missing_image_stops_without_pull_or_container_creation(self):
        with patch.object(runner, 'local_docker', return_value=['docker']), \
                patch.object(runner, 'checked', return_value=result(code=1)) as check, \
                patch.object(runner, 'run_pattern') as pattern, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.run_db_tests(), 2)
        pattern.assert_not_called()
        self.assertEqual(check.call_count, 1)
        self.assertEqual(check.call_args[0][0][1:3], ['image', 'inspect'])


if __name__ == '__main__':
    unittest.main()
