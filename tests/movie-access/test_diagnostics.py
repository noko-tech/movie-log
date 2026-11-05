"""Offline diagnostic tests: no Docker commands, SQL or network access."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from test_safety import CONTAINER_ID, IMAGE_ID, good_info, result, runner


class IsolationDiagnosticTests(unittest.TestCase):
    def setUp(self):
        # Fail closed if any test forgets to replace an external command.
        guard = patch.object(runner, 'command', side_effect=AssertionError('External command forbidden'))
        guard.start()
        self.addCleanup(guard.stop)

    def failure(self, info, running=False, phase='pre-start'):
        with self.assertRaises(runner.Failure) as caught:
            runner.validate_isolation(info, running=running, phase=phase)
        self.assertEqual(caught.exception.stage, 'isolation')
        self.assertEqual(caught.exception.reason, 'unexpected_container_settings')
        return caught.exception

    def report(self, error):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            runner.report_failure(error, 'fresh-restricted')
        lines = output.getvalue().splitlines()
        diagnostics = [json.loads(line.removeprefix('MISMATCH '))
                       for line in lines[1:]]
        return output.getvalue(), diagnostics

    def disposable(self):
        return runner.Disposable(['docker', '--host', 'unix:///tmp/mock.sock'],
                                 runner.CASES[0], IMAGE_ID, runner.Budget(1200))

    def test_each_host_predicate_identifies_the_mismatched_field(self):
        cases = [
            ('NetworkMode', 'host', 'HostConfig.NetworkMode'),
            ('PortBindings', {'5432/tcp': []}, 'HostConfig.PortBindings'),
            ('PublishAllPorts', True, 'HostConfig.PublishAllPorts'),
            ('Binds', ['/unexpected:/data'], 'HostConfig.Binds'),
            ('VolumesFrom', ['unexpected'], 'HostConfig.VolumesFrom'),
            ('Privileged', True, 'HostConfig.Privileged'),
            ('ReadonlyRootfs', False, 'HostConfig.ReadonlyRootfs'),
            ('CapAdd', ['SYS_ADMIN'], 'HostConfig.CapAdd'),
            ('CapDrop', [], 'HostConfig.CapDrop'),
            ('SecurityOpt', [], 'HostConfig.SecurityOpt'),
            ('NanoCpus', 0, 'HostConfig.NanoCpus'),
            ('Memory', 0, 'HostConfig.Memory'),
            ('MemorySwap', -1, 'HostConfig.MemorySwap'),
            ('PidsLimit', 0, 'HostConfig.PidsLimit'),
            ('Tmpfs', {'/tmp': runner.TMPFS, '/other': 'rw'}, 'HostConfig.Tmpfs.paths'),
            ('Tmpfs', {'/tmp': 'rw,mode=1777'}, 'HostConfig.Tmpfs.options'),
        ]
        for key, value, item in cases:
            with self.subTest(item=item):
                info = good_info()
                info['host'][key] = value
                error = self.failure(info)
                self.assertEqual([m['item'] for m in error.mismatches], [item])
                _, diagnostics = self.report(error)
                self.assertEqual(diagnostics[0]['item'], item)
                self.assertEqual(set(diagnostics[0]), {'phase', 'item', 'expected', 'actual'})

    def test_each_container_predicate_identifies_the_mismatched_field(self):
        cases = [
            ('user', 'root', 'Config.User'),
            ('mounts', [{'Type': 'bind', 'Destination': '/tmp'}], 'Mounts'),
            ('ports', {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '12345'}]}, 'NetworkSettings.Ports'),
            ('networks', {'bridge': {}}, 'NetworkSettings.Networks.allowed'),
            ('networks', {}, 'NetworkSettings.Networks.ready'),
        ]
        for key, value, item in cases:
            with self.subTest(item=item):
                info = good_info()
                info[key] = value
                error = self.failure(info, running=True)
                self.assertIn(item, [m['item'] for m in error.mismatches])

    def test_all_simultaneous_mismatches_have_expected_and_actual_values(self):
        info = good_info()
        info['host'].update(NetworkMode='bridge', Memory=0, ReadonlyRootfs=False)
        error = self.failure(info, phase='post-tests')
        output, diagnostics = self.report(error)
        self.assertIn('phase=post-tests', output)
        self.assertEqual(diagnostics, [
            {'phase': 'post-tests', 'item': 'HostConfig.NetworkMode', 'expected': 'none', 'actual': 'bridge'},
            {'phase': 'post-tests', 'item': 'HostConfig.ReadonlyRootfs', 'expected': True, 'actual': False},
            {'phase': 'post-tests', 'item': 'HostConfig.Memory', 'expected': runner.MEMORY, 'actual': 0},
        ])

    def test_no_diagnostics_or_output_for_valid_settings(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            for phase in ('pre-start', 'post-start', 'post-tests'):
                runner.validate_isolation(good_info(), running=phase != 'pre-start', phase=phase)
        self.assertEqual(output.getvalue(), '')

    def test_tmpfs_representation_and_capability_mismatches_are_still_rejected(self):
        for old, new in [('size=536870912', 'size=512m'), ('mode=1777', 'mode=01777')]:
            with self.subTest(representation=new):
                info = good_info()
                info['host']['Tmpfs']['/tmp'] = runner.TMPFS.replace(old, new)
                error = self.failure(info)
                diagnostic = error.mismatches[0]
                self.assertEqual(diagnostic['item'], 'HostConfig.Tmpfs.options')
                self.assertEqual(diagnostic['expected'], runner.TMPFS.split(','))
                self.assertIn(new, diagnostic['actual'])
        info = good_info()
        info['host']['CapDrop'] = ['CAP_ALL']
        self.assertEqual(self.failure(info).mismatches[0]['actual'], ['CAP_ALL'])

    def test_original_tmpfs_order_independence_is_preserved(self):
        info = good_info()
        info['host']['Tmpfs']['/tmp'] = ','.join(reversed(runner.TMPFS.split(',')))
        runner.validate_isolation(info, running=True, phase='post-start')

    def test_missing_tmpfs_reports_both_path_and_option(self):
        info = good_info()
        info['host']['Tmpfs'] = None
        diagnostics = self.failure(info).mismatches
        self.assertEqual([m['item'] for m in diagnostics],
                         ['HostConfig.Tmpfs.paths', 'HostConfig.Tmpfs.options'])
        self.assertEqual(diagnostics[1]['actual'], '<missing>')

    def test_secret_strings_paths_bindings_and_environment_are_not_reported(self):
        secret = 'SYNTHETIC_DO_NOT_ECHO_7f3a'
        info = good_info()
        info['host'].update(
            NetworkMode=secret, PortBindings={secret: [{'HostIp': secret, 'HostPort': secret}]},
            Binds=['/private/' + secret + ':/data'], VolumesFrom=[secret],
            CapAdd=[secret], CapDrop=[secret], SecurityOpt=[secret],
            NanoCpus=secret, Memory=secret, MemorySwap=secret, PidsLimit=secret,
            Tmpfs={'/tmp': 'rw,nosuid,nodev,size=' + secret + ',mode=' + secret,
                   '/private/' + secret: secret}, ExtraSecret=secret)
        info.update(user=secret, running=secret, Env=['CLIENT_SECRET=' + secret],
                    mounts=[{'Type': secret, 'Destination': '/private/' + secret,
                             'Source': secret, 'Name': secret}],
                    ports={secret: [{'HostIp': secret, 'HostPort': secret}]},
                    networks={secret: {'IPAddress': secret}})
        error = self.failure(info, running=True)
        output, diagnostics = self.report(error)
        self.assertNotIn(secret, output)
        self.assertNotIn(secret, json.dumps(error.mismatches))
        self.assertNotIn('CLIENT_SECRET', output)
        self.assertNotIn('/private/', output)
        self.assertIn('<redacted', output)
        self.assertGreater(len(diagnostics), 10)

    def test_unexpected_nested_values_are_summarized_without_contents(self):
        secret = 'SYNTHETIC_HIDDEN_VALUE'
        info = good_info()
        info['host']['Memory'] = {'key': secret}
        info['host']['CapAdd'] = [{'key': secret}]
        output, _ = self.report(self.failure(info))
        self.assertNotIn(secret, output)
        self.assertIn('<redacted-or-invalid-value>', output)

    def test_output_sanitizers_bound_and_redact_unexpected_values(self):
        for value in [float('nan'), float('inf'), 2**64, 'SYNTHETIC_HIDDEN']:
            with self.subTest(value_type=type(value).__name__):
                self.assertEqual(runner.safe_scalar(value), '<redacted-or-invalid-value>')
        options = runner.safe_tmpfs_options(','.join(['rw'] * 40))
        self.assertEqual(len(options), 33)
        self.assertEqual(options[-1], '<remaining-options-redacted>')
        self.assertEqual(len(runner.safe_items(['ALL'] * 40, ('ALL',))), 33)
        self.assertEqual(len(runner.safe_mounts([{}] * 40)), 33)

    def test_diagnostic_error_does_not_bypass_rejection_or_echo_exception(self):
        info = good_info()
        info['host']['Memory'] = 0
        with patch.object(runner, 'isolation_mismatches', side_effect=ValueError('SYNTHETIC_HIDDEN')):
            error = self.failure(info)
        output, diagnostics = self.report(error)
        self.assertNotIn('SYNTHETIC_HIDDEN', output)
        self.assertEqual(diagnostics[0]['item'], 'diagnostics')
        self.assertEqual(diagnostics[0]['actual'], 'unavailable-values-suppressed')

    def test_unknown_phase_never_echoes_untrusted_value(self):
        info = good_info()
        info['host']['Memory'] = 0
        output, diagnostics = self.report(self.failure(info, phase='SYNTHETIC_HIDDEN'))
        self.assertNotIn('SYNTHETIC_HIDDEN', output)
        self.assertEqual(diagnostics[0]['phase'], 'unspecified')

    def test_pre_start_failure_blocks_start_and_sql_and_reports_phase(self):
        test = self.disposable()
        info = good_info()
        info['host']['Memory'] = 0
        with patch.object(test, 'call', return_value=result(CONTAINER_ID)) as call, \
                patch.object(test, 'inspect', return_value=info), \
                patch.object(test, 'sql') as sql, self.assertRaises(runner.Failure) as caught:
            test.start()
        self.assertEqual(caught.exception.phase, 'pre-start')
        self.assertEqual([c.args[0][0] for c in call.call_args_list], ['create'])
        sql.assert_not_called()

    def test_post_start_failure_blocks_sql_and_reports_stopped_container(self):
        test = self.disposable()
        stopped = good_info()
        stopped['running'] = False
        with patch.object(test, 'call', return_value=result(CONTAINER_ID)) as call, \
                patch.object(test, 'inspect', side_effect=[good_info(), stopped]), \
                patch.object(test, 'sql') as sql, self.assertRaises(runner.Failure) as caught:
            test.start()
        self.assertEqual(caught.exception.phase, 'post-start')
        self.assertEqual([c.args[0][0] for c in call.call_args_list], ['create', 'start', 'logs'])
        self.assertEqual(caught.exception.stage, 'container-startup')
        self.assertEqual(caught.exception.reason, 'container_exited')
        self.assertEqual(caught.exception.mismatches, ())
        self.assertIs(caught.exception.container_state['Running'], False)
        sql.assert_not_called()

    def test_post_tests_failure_has_distinct_phase(self):
        test = self.disposable()
        info = good_info()
        info['host']['Memory'] = 0
        with patch.object(test, 'start'), patch.object(test, 'inspect', return_value=info), \
                patch.object(test, 'sql', return_value=result(stderr='NOTICE: PASS synthetic')) as sql, \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(runner.Failure) as caught:
            test.execute()
        self.assertEqual(caught.exception.phase, 'post-tests')
        self.assertEqual(sql.call_count, len(runner.steps_for(test.case)))

    def test_cleanup_and_diagnostic_propagation_after_isolation_failure(self):
        info = good_info()
        info['host']['Memory'] = 0
        failure = self.failure(info, phase='pre-start')
        test = self.disposable()
        with patch.object(runner, 'Disposable', return_value=test), \
                patch.object(test, 'execute', side_effect=failure), patch.object(test, 'cleanup') as cleanup, \
                self.assertRaises(runner.Failure) as caught:
            runner.run_pattern([], runner.CASES[0], IMAGE_ID, runner.Budget(10))
        cleanup.assert_called_once_with()
        self.assertIs(caught.exception, failure)


if __name__ == '__main__':
    unittest.main()
