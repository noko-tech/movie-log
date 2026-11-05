"""Offline tests for the independent startup probe; all external calls blocked."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from test_safety import CONTAINER_ID, IMAGE_ID, good_info, result

_spec = importlib.util.spec_from_file_location('minimal_postgres_diagnostic',
                                             Path(__file__).with_name('diagnose_postgres_startup.py'))
diagnostic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(diagnostic)


class MinimalStartupDiagnosticTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(diagnostic.safety, 'command', side_effect=AssertionError('External command forbidden'))
        guard.start()
        self.addCleanup(guard.stop)
        sql_guard = patch.object(diagnostic.safety.Disposable, 'sql', side_effect=AssertionError('SQL forbidden'))
        sql_guard.start()
        self.addCleanup(sql_guard.stop)

    def probe(self):
        return diagnostic.StartupDiagnostic(['docker', '--host', 'unix:///tmp/mock.sock'],
                                            IMAGE_ID, diagnostic.safety.Budget(240))

    def capture(self, function, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            value = function(*args)
        return value, output.getvalue()

    def mock_runtime(self, probe):
        return (patch.object(diagnostic.safety, 'local_docker', return_value=['docker']),
                patch.object(diagnostic.safety, 'checked', return_value=result(json.dumps({'id': IMAGE_ID, 'volumes': None}))),
                patch.object(diagnostic, 'StartupDiagnostic', return_value=probe),
                patch.object(diagnostic.signal, 'signal'), patch.object(diagnostic.signal, 'getsignal'))

    def test_default_mode_is_static_only_and_runtime_requires_exact_opt_in(self):
        with patch.object(diagnostic, 'run_diagnostic', side_effect=AssertionError('Runtime forbidden')):
            code, output = self.capture(diagnostic.main, [])
        self.assertEqual(code, 0)
        self.assertEqual(output, 'stage=static-check status=PASS exit_code=0\n')
        with patch.object(diagnostic, 'run_diagnostic', return_value=7) as run:
            self.assertEqual(diagnostic.main(['--run-disposable-db']), 7)
        run.assert_called_once_with()

    def test_bad_arguments_and_unexpected_values_never_echo_secrets(self):
        code, output = self.capture(diagnostic.main, ['--db-url', 'SYNTHETIC_SECRET_VALUE'])
        self.assertEqual(code, 2)
        self.assertNotIn('SYNTHETIC_', output)
        _, output = self.capture(diagnostic.emit, 'SYNTHETIC_SECRET_VALUE', False, 'SYNTHETIC_SECRET_VALUE')
        self.assertEqual(output, 'stage=diagnostic status=FAIL exit_code=unknown\n')
        for value in [True, -1, 2**64, 1.2, None]:
            _, output = self.capture(diagnostic.emit, 'initdb', False, value)
            self.assertTrue(output.endswith('exit_code=unknown\n'))

    def test_all_stages_run_separately_without_old_startup_or_sql(self):
        probe = self.probe()
        replies = [result(CONTAINER_ID), result()] + [result('SYNTHETIC_STDOUT', 'SYNTHETIC_STDERR') for _ in diagnostic.PROBES]
        with patch.object(probe.container, 'call', side_effect=replies) as call, \
                patch.object(probe.container, 'inspect', return_value=good_info()), \
                patch.object(probe.container, 'start', side_effect=AssertionError('Old startup forbidden')):
            _, output = self.capture(probe.execute)
        self.assertNotIn('SYNTHETIC_', output)
        self.assertEqual(call.call_count, 2 + len(diagnostic.PROBES))
        for invocation, (stage, script, seconds) in zip(call.call_args_list[2:], diagnostic.PROBES):
            self.assertEqual(invocation.args, (['exec', CONTAINER_ID, '/bin/sh', '-c', script], stage))
            self.assertEqual(invocation.kwargs['timeout'], seconds)
            self.assertIn('stage=' + stage + ' status=PASS exit_code=0', output)

    def test_only_keeper_changes_all_creation_flags_and_limits_are_identical(self):
        probe = self.probe()
        with patch.object(probe.container, 'call', side_effect=[result(CONTAINER_ID), result(code=1)]) as call, \
                patch.object(probe.container, 'inspect', return_value=good_info()), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(diagnostic.DiagnosticFailure):
            probe.execute()
        actual = call.call_args_list[0].args[0]
        expected = diagnostic.safety.create_arguments(probe.container.name, probe.container.nonce, IMAGE_ID)
        self.assertEqual(actual[:-1], expected[:-1])
        self.assertEqual(actual[-1], diagnostic.KEEPER)
        self.assertNotIn('timeout ', diagnostic.KEEPER)
        self.assertNotIn('initdb ', diagnostic.KEEPER)
        self.assertIn(str(diagnostic.safety.PATTERN_SECONDS), diagnostic.KEEPER)
        for flag in ['--publish', '-p', '--volume', '-v', '--mount', '--volumes-from', '--env', '-e']:
            self.assertNotIn(flag, actual)

    def test_each_failed_stage_preserves_exit_code_and_stops_later_probes(self):
        for index, (stage, _, _) in enumerate(diagnostic.PROBES):
            with self.subTest(stage=stage):
                probe = self.probe()
                replies = [result(CONTAINER_ID), result()] + [result() for _ in range(index)]
                replies.append(result('SYNTHETIC_STDOUT', 'SYNTHETIC_STDERR', code=127))
                with patch.object(probe.container, 'call', side_effect=replies) as call, \
                        patch.object(probe.container, 'inspect', return_value=good_info()), \
                        contextlib.redirect_stdout(io.StringIO()), self.assertRaises(diagnostic.DiagnosticFailure) as caught:
                    probe.execute()
                self.assertEqual(caught.exception.stage, stage)
                self.assertEqual(caught.exception.code, 127)
                self.assertEqual(call.call_count, 3 + index)

    def test_isolation_violation_stops_before_start(self):
        probe = self.probe()
        bad = good_info()
        bad['host']['ReadonlyRootfs'] = False
        with patch.object(probe.container, 'call', return_value=result(CONTAINER_ID)) as call, \
                patch.object(probe.container, 'inspect', return_value=bad), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(diagnostic.safety.Failure):
            probe.execute()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(probe.stage, 'isolation-pre-start')

    def test_live_container_requires_none_network_and_stopped_container_fails(self):
        for values, error_type in [({'networks': {}}, diagnostic.safety.Failure),
                                   ({'running': False, 'exit_code': 1, 'networks': {}}, diagnostic.DiagnosticFailure),
                                   ({'running': None}, diagnostic.DiagnosticFailure)]:
            probe = self.probe()
            info = good_info()
            info.update(values)
            with self.subTest(values=values), patch.object(probe.container, 'inspect', return_value=info), \
                    self.assertRaises(error_type):
                probe.isolation(running=True)

    def test_runtime_failure_interrupt_and_cleanup_failure_print_no_raw_details(self):
        for error in [diagnostic.DiagnosticFailure('initdb', 1), ValueError('SYNTHETIC_SECRET'), KeyboardInterrupt()]:
            probe = Mock(stage='initdb')
            probe.execute.side_effect = error
            patches = self.mock_runtime(probe)
            with patches[0], patches[1], patches[2], patches[3], patches[4]:
                code, output = self.capture(diagnostic.run_diagnostic)
            self.assertEqual(code, 1)
            probe.cleanup.assert_called_once_with()
            self.assertNotIn('SYNTHETIC_', output)
            self.assertIn('stage=initdb status=FAIL', output)
            self.assertIn('stage=cleanup status=PASS exit_code=0', output)
        probe = Mock(stage='postgres-server')
        probe.cleanup.side_effect = ValueError('SYNTHETIC_SECRET')
        patches = self.mock_runtime(probe)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            code, output = self.capture(diagnostic.run_diagnostic)
        self.assertEqual(code, 1)
        self.assertNotIn('SYNTHETIC_', output)
        self.assertIn('stage=cleanup status=FAIL exit_code=unknown', output)

    def test_absent_or_volume_declaring_image_stops_without_create_or_download(self):
        for response in [result(stderr='SYNTHETIC_SECRET', code=1),
                         result(json.dumps({'id': IMAGE_ID, 'volumes': {'/SYNTHETIC_SECRET': {}}}))]:
            with patch.object(diagnostic.safety, 'local_docker', return_value=['docker']), \
                    patch.object(diagnostic.safety, 'checked', return_value=response) as checked, \
                    patch.object(diagnostic, 'StartupDiagnostic') as constructor, \
                    patch.object(diagnostic.signal, 'signal'), patch.object(diagnostic.signal, 'getsignal'):
                code, output = self.capture(diagnostic.run_diagnostic)
            self.assertEqual(code, 1)
            self.assertNotIn('SYNTHETIC_', output)
            self.assertIn('stage=cached-image status=FAIL', output)
            constructor.assert_not_called()
            self.assertEqual(checked.call_count, 1)

    def test_cleanup_deletes_only_confirmed_test_id_without_volume_removal(self):
        probe = self.probe()
        test = probe.container
        test.id, test.attempted = CONTAINER_ID, True
        info = good_info()
        info.update(name='/' + test.name, label=test.nonce)
        test.budget.end = -1
        with patch.object(diagnostic.safety, 'command', side_effect=[result(json.dumps(info)), result(), result()]) as command:
            _, output = self.capture(probe.cleanup)
        self.assertEqual(output, '')
        self.assertEqual(command.call_args_list[1].args[0][-3:], ['rm', '--force', CONTAINER_ID])
        self.assertNotIn('-v', command.call_args_list[1].args[0])
        self.assertTrue(all(c.args[2] > 0 for c in command.call_args_list))

    def test_probe_commands_use_unix_socket_and_pg_isready_without_sql(self):
        probes = {name: script for name, script, _ in diagnostic.PROBES}
        self.assertIn('--locale=C --encoding=UTF8', probes['initdb'])
        self.assertIn("listen_addresses=''", probes['postgres-server'])
        self.assertIn('pg_isready -q -h /tmp', probes['postgres-server'])
        self.assertIn('>/tmp/postgres.log 2>&1', probes['postgres-server'])
        self.assertIn('wait "$diag_pid"', probes['postgres-server'])
        for script in probes.values():
            self.assertNotIn('psql', script)
            self.assertNotIn('SELECT ', script)
            self.assertNotIn('supabase', script)


if __name__ == '__main__':
    unittest.main()
