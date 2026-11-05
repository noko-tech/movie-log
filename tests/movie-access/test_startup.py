"""Static/mocked lifecycle diagnostics: never start Docker or execute SQL."""
import contextlib
import io
import json
import shlex
import unittest
from unittest.mock import patch

from test_safety import CONTAINER_ID, IMAGE_ID, good_info, result, runner


class StartupDiagnosticTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(runner, 'command', side_effect=AssertionError('External command forbidden'))
        guard.start()
        self.addCleanup(guard.stop)

    def disposable(self):
        test = runner.Disposable(['docker', '--host', 'unix:///tmp/mock.sock'],
                                 runner.CASES[0], IMAGE_ID, runner.Budget(1200))
        test.id = CONTAINER_ID
        return test

    def stopped(self, **overrides):
        info = good_info()
        info.update(running=False, exit_code=1, oom_killed=False)
        info.update(overrides)
        return info

    def report(self, error):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            runner.report_failure(error, 'fresh-restricted')
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[1].startswith('CONTAINER '))
        return output.getvalue(), json.loads(lines[1][len('CONTAINER '):])

    def test_inspect_collects_exit_code_and_oom_without_raw_state_error_or_environment(self):
        self.assertIn('{{json .State.ExitCode}}', runner.INSPECT_FORMAT)
        self.assertIn('{{json .State.OOMKilled}}', runner.INSPECT_FORMAT)
        self.assertNotIn('.State.Error', runner.INSPECT_FORMAT)
        self.assertNotIn('.Config.Env', runner.INSPECT_FORMAT)

    def test_initdb_failure_reports_only_fixed_message_and_typed_state(self):
        test = self.disposable()
        logs = '\n'.join([runner.INITDB_STARTED, 'SYNTHETIC_PASSWORD_HIDDEN', runner.INITDB_FAILED])
        with patch.object(test, 'call', return_value=result(logs, 'SYNTHETIC_KEY_HIDDEN')) as call:
            error = test.stopped_failure(self.stopped(), 'post-start')
        output, diagnostic = self.report(error)
        self.assertEqual(error.stage, 'container-startup')
        self.assertEqual(error.reason, 'container_exited')
        self.assertEqual(diagnostic, {'Running': False, 'ExitCode': 1, 'OOMKilled': False,
                                     'message': 'initdb_failed', 'phase': 'post-start'})
        self.assertNotIn('SYNTHETIC_', output)
        self.assertNotIn('MOVIE_ACCESS_STARTUP:', output)
        self.assertEqual(call.call_args.args[0], ['logs', '--tail', '16', CONTAINER_ID])
        self.assertEqual(call.call_args.kwargs['timeout'], 5)
        self.assertTrue(call.call_args.kwargs['allow_failure'])

    def test_postgres_exit_and_oom_have_explicit_distinct_metadata(self):
        for exit_code, oom in [(1, False), (137, True), (0, False)]:
            with self.subTest(exit_code=exit_code, oom=oom):
                test = self.disposable()
                logs = runner.INITDB_STARTED + '\n' + runner.POSTGRES_STARTING + '\n'
                with patch.object(test, 'call', return_value=result(logs)):
                    error = test.stopped_failure(self.stopped(exit_code=exit_code, oom_killed=oom), 'post-start')
                _, diagnostic = self.report(error)
                self.assertEqual(diagnostic['ExitCode'], exit_code)
                self.assertIs(diagnostic['OOMKilled'], oom)
                self.assertEqual(diagnostic['message'], 'postgres_start_or_runtime_failed')

    def test_initdb_interruption_is_not_claimed_as_completed_failure(self):
        test = self.disposable()
        with patch.object(test, 'call', return_value=result(runner.INITDB_STARTED + '\n')):
            error = test.stopped_failure(self.stopped(exit_code=137, oom_killed=True), 'post-start')
        self.assertEqual(error.container_state['message'], 'initdb_did_not_complete')

    def test_marker_parser_accepts_only_exact_lines_and_uses_last_observed_stage(self):
        for output in ['SYNTHETIC_SECRET', 'prefix ' + runner.INITDB_FAILED,
                       runner.INITDB_FAILED + ' suffix', ' ' + runner.POSTGRES_STARTING,
                       runner.POSTGRES_STARTING.lower()]:
            with self.subTest(output_type='unrecognized'):
                self.assertEqual(runner.startup_message(output), 'startup_step_unknown')
        self.assertEqual(runner.startup_message(runner.INITDB_STARTED + '\n' + runner.INITDB_FAILED),
                         'initdb_failed')

    def test_missing_logs_nonzero_log_command_and_deadline_do_not_mask_exit(self):
        for response in [result(), result(stdout=None), result(runner.INITDB_FAILED, 'SYNTHETIC_SECRET', code=1),
                         runner.Failure('startup-diagnostics', 'command_timeout'),
                         runner.Failure('startup-diagnostics', 'deadline_exceeded')]:
            with self.subTest(response_type=type(response).__name__):
                test = self.disposable()
                with patch.object(test, 'call') as call:
                    if isinstance(response, Exception):
                        call.side_effect = response
                    else:
                        call.return_value = response
                    error = test.stopped_failure(self.stopped(exit_code=137, oom_killed=True), 'post-start')
                output, diagnostic = self.report(error)
                self.assertEqual(error.reason, 'container_exited')
                self.assertEqual(diagnostic['ExitCode'], 137)
                self.assertIs(diagnostic['OOMKilled'], True)
                self.assertEqual(diagnostic['message'], 'startup_step_unknown')
                self.assertNotIn('SYNTHETIC_SECRET', output)

    def test_unexpected_state_values_and_message_are_redacted(self):
        secret = 'SYNTHETIC_SECRET_VALUE'
        for value in [secret, {'key': secret}, [secret], None]:
            with self.subTest(value_type=type(value).__name__):
                error = runner.Failure('container-startup', 'container_state_unavailable', phase='post-start',
                                       container_state={'running': value, 'exit_code': value, 'oom_killed': value,
                                                        'Error': secret, 'Env': [secret]}, startup_message=secret)
                output, diagnostic = self.report(error)
                self.assertNotIn(secret, output)
                self.assertEqual(diagnostic['Running'], '<unavailable>')
                self.assertEqual(diagnostic['ExitCode'], '<unavailable>')
                self.assertEqual(diagnostic['OOMKilled'], '<unavailable>')
                self.assertEqual(diagnostic['message'], 'startup_step_unknown')
        for invalid in [True, False, -1, 2**63, 1.0]:
            self.assertEqual(runner.safe_container_state({'exit_code': invalid}, '')['ExitCode'], '<unavailable>')

    def test_runtime_exit_at_end_has_runtime_stage(self):
        test = self.disposable()
        with patch.object(test, 'inspect', return_value=self.stopped()), \
                patch.object(test, 'call', return_value=result(runner.POSTGRES_STARTING)), \
                self.assertRaises(runner.Failure) as caught:
            test.check_running('post-tests')
        self.assertEqual(caught.exception.stage, 'container-runtime')
        self.assertEqual(caught.exception.phase, 'post-tests')
        self.assertEqual(caught.exception.reason, 'container_exited')

    def test_exit_without_network_attachment_is_startup_failure_not_isolation(self):
        test = self.disposable()
        with patch.object(test, 'inspect', return_value=self.stopped(networks={})), \
                patch.object(test, 'call', return_value=result()), \
                self.assertRaises(runner.Failure) as caught:
            test.check_running('post-start')
        self.assertEqual(caught.exception.stage, 'container-startup')
        self.assertEqual(caught.exception.mismatches, ())

    def test_isolation_violation_takes_priority_even_when_container_exited(self):
        test = self.disposable()
        info = self.stopped()
        info['host']['NetworkMode'] = 'bridge'
        with patch.object(test, 'inspect', return_value=info), patch.object(test, 'call') as call, \
                self.assertRaises(runner.Failure) as caught:
            test.check_running('post-start')
        self.assertEqual(caught.exception.stage, 'isolation')
        self.assertEqual(caught.exception.reason, 'unexpected_container_settings')
        call.assert_not_called()

    def test_healthy_container_requires_none_network_and_never_reads_logs(self):
        test = self.disposable()
        with patch.object(test, 'inspect', return_value=good_info()), patch.object(test, 'call') as call:
            test.check_running('post-start')
        call.assert_not_called()
        info = good_info()
        info['networks'] = {}
        with patch.object(test, 'inspect', return_value=info), patch.object(test, 'call') as call, \
                self.assertRaises(runner.Failure) as caught:
            test.check_running('post-start')
        self.assertEqual(caught.exception.stage, 'isolation')
        call.assert_not_called()

    def test_invalid_running_state_is_rejected_without_assuming_exit(self):
        test = self.disposable()
        for invalid in [None, 'SYNTHETIC_SECRET', 1]:
            with self.subTest(value_type=type(invalid).__name__), \
                    patch.object(test, 'inspect', return_value=self.stopped(running=invalid)), \
                    patch.object(test, 'call', return_value=result()), self.assertRaises(runner.Failure) as caught:
                test.check_running('post-start')
            self.assertEqual(caught.exception.reason, 'container_state_unavailable')
            self.assertEqual(caught.exception.container_state['Running'], '<unavailable>')

    def test_docker_start_command_failure_is_classified_and_blocks_sql(self):
        test = self.disposable()
        with patch.object(test, 'inspect', return_value=good_info()), \
                patch.object(test, 'call', side_effect=[result(CONTAINER_ID), result(stderr='SYNTHETIC_SECRET', code=1)]) as call, \
                patch.object(test, 'sql') as sql, self.assertRaises(runner.Failure) as caught:
            test.start()
        self.assertEqual(caught.exception.stage, 'container-startup')
        self.assertEqual(caught.exception.reason, 'docker_start_failed')
        self.assertEqual(caught.exception.phase, 'post-start')
        self.assertEqual(call.call_count, 2)
        sql.assert_not_called()
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            runner.report_failure(caught.exception)
        self.assertNotIn('SYNTHETIC_SECRET', output.getvalue())

    def test_start_command_timeout_is_classified_without_raw_details(self):
        test = self.disposable()
        with patch.object(test, 'inspect', return_value=good_info()), \
                patch.object(test, 'call', side_effect=[result(CONTAINER_ID), runner.Failure('start', 'command_timeout')]), \
                patch.object(test, 'sql') as sql, self.assertRaises(runner.Failure) as caught:
            test.start()
        self.assertEqual(caught.exception.stage, 'container-startup')
        self.assertEqual(caught.exception.reason, 'command_timeout')
        sql.assert_not_called()

    def test_startup_failure_still_removes_only_own_container_without_volumes(self):
        test = self.disposable()
        owned = self.stopped()
        owned.update(name='/' + test.name, label=test.nonce)
        with patch.object(runner, 'Disposable', return_value=test), \
                patch.object(test, 'inspect', side_effect=[good_info(), self.stopped()]), \
                patch.object(test, 'call', side_effect=[result(CONTAINER_ID), result(), result(runner.INITDB_FAILED)]), \
                patch.object(test, 'sql') as sql, \
                patch.object(runner, 'command', side_effect=[result(json.dumps(owned)), result(), result()]) as command, \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(runner.Failure) as caught:
            runner.run_pattern([], runner.CASES[0], IMAGE_ID, runner.Budget(1200))
        self.assertEqual(caught.exception.reason, 'container_exited')
        self.assertEqual(command.call_count, 3)
        removal = command.call_args_list[1].args[0]
        self.assertEqual(removal[-3:], ['rm', '--force', CONTAINER_ID])
        self.assertNotIn('-v', removal)
        sql.assert_not_called()

    def test_shell_has_fixed_markers_preserves_exit_status_and_hides_process_output(self):
        args = runner.create_arguments('test-only', 'test-only', IMAGE_ID)
        outer = shlex.split(args[-1])
        self.assertEqual(outer[:9], ['exec', 'timeout', '-s', 'TERM', '-k', '5',
                                   '240', '/bin/sh', '-c'])
        script = outer[-1]
        self.assertIn('if initdb ', script)
        self.assertIn('>/tmp/initdb.log 2>&1; then', script)
        self.assertIn('exec postgres ', script)
        self.assertIn('>/tmp/postgres.log 2>&1', script)
        self.assertIn('initdb_status=$?', script)
        self.assertIn('exit "$initdb_status"', script)
        self.assertLess(script.index(runner.INITDB_STARTED), script.index('if initdb '))
        self.assertLess(script.index(runner.POSTGRES_STARTING), script.index('exec postgres '))
        self.assertLess(script.index('else'), script.index(runner.INITDB_FAILED))

    def test_busybox_timeout_rejects_gnu_long_options_and_keeps_numeric_limits(self):
        # Regression: the cached image has BusyBox 1.37 timeout, not GNU timeout.
        # Keep the TERM deadline and subsequent KILL while avoiding long options.
        for seconds in (240, 60):
            with self.subTest(seconds=seconds), patch.object(runner, 'PATTERN_SECONDS', seconds):
                outer = shlex.split(runner.create_arguments('test-only', 'test-only', IMAGE_ID)[-1])
            self.assertEqual(outer[:6], ['exec', 'timeout', '-s', 'TERM', '-k', '5'])
            self.assertEqual(outer[6], str(seconds))
            self.assertTrue(outer[6].isascii() and outer[6].isdigit())
            self.assertEqual(outer[7:9], ['/bin/sh', '-c'])
            self.assertFalse(any(token.startswith('--') for token in outer[2:9]))


if __name__ == '__main__':
    unittest.main()
