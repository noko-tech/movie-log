#!/usr/bin/env python3
"""Run real SQL in a NEW offline Docker container. No DB URLs or credentials."""
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import uuid
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
# Existing Supabase PostgreSQL image; version fixed for reproducibility.
IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.002"
NAME = "movie-log-google-invite-test-" + uuid.uuid4().hex[:12]
DOCKER = None


def command(args, *, source=None, timeout=60, check=True, env=None):
    result = subprocess.run(
        args, input=source, text=True, capture_output=True, timeout=timeout, env=env,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Command failed")
    return result


def local_docker():
    """Inspect configuration without contacting a daemon, then pin a local socket."""
    context = os.environ.get("DOCKER_CONTEXT")
    if context:
        endpoint = command([
            "docker", "context", "inspect", context,
            "--format", "{{.Endpoints.docker.Host}}",
        ]).stdout.strip()
    elif os.environ.get("DOCKER_HOST"):
        endpoint = os.environ["DOCKER_HOST"]
    else:
        endpoint = command([
            "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}",
        ]).stdout.strip()
    parsed = urlsplit(endpoint)
    if parsed.scheme != "unix" or parsed.netloc or parsed.query or parsed.fragment:
        raise RuntimeError("安全のため停止: ローカルのDocker Unixソケット以外は利用できません。")
    socket = pathlib.Path(unquote(parsed.path))
    if not socket.is_absolute() or not stat.S_ISSOCK(socket.stat().st_mode):
        raise RuntimeError("安全のため停止: DockerのローカルUnixソケットが見つかりません。")
    return ["docker", "--host", endpoint]


def docker(args, **kwargs):
    # Pin the inspected socket. Environment overrides cannot switch the daemon
    # between preflight, creation, SQL execution, and cleanup.
    env = {key: value for key, value in os.environ.items() if key not in (
        "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_TLS",
    )}
    return command(DOCKER + args, env=env, **kwargs)


def sql(source, user="bootstrap", check=True):
    # No host / port / URL accepted. psql connects via a new container's Unix socket.
    # No host env is forwarded. -X ignores any psql startup configuration.
    return docker([
        "exec", "-i", NAME, "psql", "-X", "-q", "-t", "-A",
        "-h", "/tmp", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1",
    ], source=source, check=check)


def main():
    global DOCKER
    if len(sys.argv) != 1:
        print("引数は受け付けません。既存DBや接続URLは指定できません。", file=sys.stderr)
        return 1
    created = False
    result_code = 1
    try:
        DOCKER = local_docker()
        print("接続先確認: このPCのDocker Unixソケット。既存DBへの接続設定は使用しません。", flush=True)
        docker(["info", "--format", "{{.ServerVersion}}"], timeout=10)
        image = docker(["image", "inspect", "--format", "{{.Id}}", IMAGE], check=False)
        if image.returncode:
            print("未実施: ローカルに必要なPostgreSQLイメージがありません。", file=sys.stderr)
            print("準備: docker pull " + IMAGE, file=sys.stderr)
            return 2
        print("PostgreSQL image:", IMAGE, flush=True)
        print("Image ID:", image.stdout.strip(), flush=True)
        # No published port, no host mounts, no project secrets, no external network.
        docker([
            "create", "--pull", "never", "--name", NAME, "--network", "none",
            "--user", "postgres", "--entrypoint", "/bin/sh",
            "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", IMAGE, "-c",
            "initdb -D /tmp/invite-pg -U bootstrap -A trust --locale=C --encoding=UTF8 "
            ">/tmp/initdb.log 2>&1 && "
            "exec postgres -D /tmp/invite-pg -k /tmp -c listen_addresses='' "
            "-c log_statement=none -c log_min_error_statement=panic",
        ])
        created = True
        isolation = json.loads(docker([
            "inspect", "--format",
            '{"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},'
            '"mounts":{{json .Mounts}},"user":{{json .Config.User}}}', NAME,
        ]).stdout)
        if (isolation["network"] != "none" or isolation["ports"]
                or isolation["user"] != "postgres"
                or any(mount["Type"] == "bind" for mount in isolation["mounts"])):
            raise RuntimeError("安全のため停止: テストコンテナの隔離設定が一致しません。")
        print("隔離確認: 外部通信なし・公開ポートなし・ホストフォルダ共有なし。", flush=True)
        docker(["start", NAME])
        for _ in range(100):
            if sql("SELECT 1", check=False).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("使い捨てPostgreSQLの起動に失敗しました。")

        connection = sql("SELECT current_user='bootstrap' AND current_database()='postgres' "
                         "AND inet_server_addr() IS NULL AND current_setting('listen_addresses')='';")
        if connection.stdout.strip() != "t":
            raise RuntimeError("安全のため停止: 新規DBのUnixソケット接続を確認できません。")
        print("PASS isolated local database via Unix socket", flush=True)

        sql((HERE / "bootstrap.sql").read_text())
        migration = (ROOT / "supabase/migrations/20261031000100_google_invite_auth.sql").read_text()
        # Apply via a non-superuser migration session with SET ROLE permission.
        result = sql(migration + "\nSELECT current_user;", user="migration_runner")
        if result.stdout.strip() != "migration_runner":
            raise RuntimeError("マイグレーション後にロールが復元されていません。")
        print("PASS migration via non-superuser; role restored", flush=True)

        result = sql((HERE / "invite.test.sql").read_text())
        passed = re.findall(r"NOTICE:\s+PASS (.+)", result.stderr)
        for name in passed:
            print("PASS", name)
        if not passed:
            raise RuntimeError("SQLテスト結果がありません。")

        # A second application must fail atomically on an existing schema.
        collision = sql(migration, user="migration_runner", check=False)
        if collision.returncode == 0 or "already exists" not in collision.stderr:
            raise RuntimeError("名前の衝突でマイグレーションが停止しませんでした。")
        sql("DO $$ BEGIN IF (SELECT value FROM preservation_fixture.baseline) "
            "IS DISTINCT FROM preservation_fixture.snapshot() THEN "
            "RAISE EXCEPTION 'preservation failed'; END IF; END $$;")
        print("PASS migration collision rejected; fixtures preserved")
        print(f"成功: {len(passed) + 3}項目。外部DB接続: 0。Auth/Google連携テスト: 未実施。")
        result_code = 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print("失敗または環境不足:", str(error), file=sys.stderr)
        result_code = 1
    finally:
        if created:
            try:
                cleanup = docker(["rm", "-f", "-v", NAME], check=False)
                if cleanup.returncode:
                    raise RuntimeError("docker rm failed")
                print("使い捨てテストコンテナ・データを削除しました。")
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                print("テストコンテナの削除に失敗:", NAME, file=sys.stderr)
                result_code = 1
    return result_code


if __name__ == "__main__":
    sys.exit(main())
