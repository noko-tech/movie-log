"""Compare process arguments offline; this cannot validate timeout/PID 1 behavior.

The independent probe passed in Docker, but does not exercise the runner's
timeout wrapper. Equality here rules out argument drift, not wrapper failure.
No shell, Docker, PostgreSQL command or SQL is executed by these tests.
"""
import shlex
import unittest
from unittest.mock import patch

from test_postgres_startup_diagnostic import diagnostic
from test_safety import IMAGE_ID, runner


def process_argv(script, command):
    # A narrow static reader for these fixed scripts, not a shell interpreter.
    lexer = shlex.shlex(script.replace('\\\n', ''), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    tokens = list(lexer)
    start = tokens.index(command)
    end = next(i for i in range(start, len(tokens)) if tokens[i] in ('<', '>', ';', '&'))
    return tokens[start:end]


class StartupCommandComparisonTests(unittest.TestCase):
    def setUp(self):
        for module in (runner, diagnostic.safety):
            guard = patch.object(module, 'command', side_effect=AssertionError('External command forbidden'))
            guard.start()
            self.addCleanup(guard.stop)
        args = runner.create_arguments('static-only', 'static-only', IMAGE_ID)
        self.runner_script = shlex.split(args[-1])[-1]
        self.probes = {stage: script for stage, script, _ in diagnostic.PROBES}

    def test_initdb_arguments_match_the_successful_independent_probe(self):
        actual = process_argv(self.runner_script, 'initdb')
        self.assertEqual(actual, process_argv(self.probes['initdb'], 'initdb'))
        self.assertEqual(actual, ['initdb', '-D', '/tmp/movie-access-pg', '-U', 'bootstrap',
                                  '-A', 'trust', '--locale=C', '--encoding=UTF8'])

    def test_server_arguments_match_including_unix_only_and_sql_time_limits(self):
        actual = process_argv(self.runner_script, 'postgres')
        self.assertEqual(actual, process_argv(self.probes['postgres-server'], 'postgres'))
        self.assertEqual(actual[:5], ['postgres', '-D', '/tmp/movie-access-pg', '-k', '/tmp'])
        self.assertEqual(actual[5::2], ['-c'] * 6)
        self.assertEqual(actual[6::2], ['listen_addresses=', 'log_statement=none',
                                      'log_min_error_statement=panic', 'statement_timeout=10000',
                                      'lock_timeout=2000', 'idle_in_transaction_session_timeout=15000'])


if __name__ == '__main__':
    unittest.main()
