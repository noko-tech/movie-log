"""Build a reviewed, byte-for-byte static Pages artifact. Standard library only."""

import argparse
import hashlib
import json
import re
import sys
from html import unescape
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


class BuildError(ValueError):
    pass


TEXT_SUFFIXES = {".html", ".css", ".js", ".svg", ".txt"}
ASSET_SUFFIXES = {".png", ".webp", ".svg", ".jpg", ".jpeg", ".ico", ".css", ".js", ".woff", ".woff2", ".ttf", ".otf"}
SECRET_PATTERNS = {
    "secret API key": rb"\bsb_secret_[A-Za-z0-9_-]{8,}",
    "JWT literal requiring review": rb"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    "private key": rb"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----",
    "database connection URL": rb"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://",
    "provider token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})",
    "possible TMDb API key": rb"[\"'][a-fA-F0-9]{32}[\"']",
}


def checked_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise BuildError("Invalid manifest path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(part.startswith(".") for part in path.parts):
        raise BuildError("Unsafe manifest path")
    if value != "index.html":
        license_file = path.suffix == ".txt" and "license" in path.name.lower()
        if path.parts[0] != "assets" or (path.suffix.lower() not in ASSET_SUFFIXES and not license_file):
            raise BuildError("Only index.html and reviewed web assets can be published")
        if re.search(r"(?:^|[-_.])(backup|dump|secret|credentials)(?:[-_.]|$)", path.name, re.I):
            raise BuildError("Backup or secret filenames cannot be published")
    return value


class ResourceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.css = []
        self.in_style = False

    def handle_starttag(self, tag, attrs):
        if tag == "style":
            self.in_style = True
        for name, value in attrs:
            if value and name in {"src", "href", "poster"}:
                self.urls.append(value)
            elif value and name == "srcset":
                self.urls.extend(item.strip().split()[0] for item in value.split(",") if item.strip())
            elif value and name == "style":
                self.css.append(value)

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.css.append(data)


def local_references(text, filename):
    parser = ResourceParser()
    parser.feed(text)
    urls = parser.urls
    css = text if filename.endswith(".css") else "\n".join(parser.css)
    for match in re.finditer(r"url\(\s*(?:\"([^\"]*)\"|'([^']*)'|([^)]*))\s*\)", css, re.I):
        urls.append(next(value for value in match.groups() if value is not None).strip())
    # Includes literal paths in inline JS templates and the Lucide license comment.
    if filename == "index.html":
        urls.extend(re.findall(r"assets/[^\s\"'<>`)+]+", text))
    result = set()
    for value in urls:
        value = unescape(value.strip())
        url = urlsplit(value)
        if not value or url.scheme or url.netloc or not url.path:
            continue
        if url.path.startswith("/"):
            raise BuildError(f"Root-relative local resource breaks Pages subpaths: {filename}")
        relative = (PurePosixPath(filename).parent / unquote(url.path)).as_posix()
        result.add(checked_path(relative))
    return result


def regular_file(root, name):
    path = root / name
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink():
            raise BuildError(f"Symbolic links cannot be published: {name}")
    if not path.is_file():
        raise BuildError(f"Required public file is missing: {name}")
    if path.stat().st_nlink != 1:
        raise BuildError(f"Hard links cannot be published: {name}")
    return path


def public_files(source):
    source = Path(source).resolve()
    manifest = source / "deploy/pages-files.json"
    if manifest.is_symlink():
        raise BuildError("Manifest must not be a symbolic link")
    try:
        config = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BuildError("Cannot read the public file manifest") from error
    if not isinstance(config, dict) or set(config) != {"files", "ignored_references"}:
        raise BuildError("Invalid manifest structure")
    names, ignored = config["files"], config["ignored_references"]
    if not isinstance(names, list) or not names or not isinstance(ignored, dict):
        raise BuildError("Invalid manifest entries")
    names = [checked_path(name) for name in names]
    if len(set(names)) != len(names) or "index.html" not in names:
        raise BuildError("Manifest must contain index.html and no duplicate paths")
    for name, reason in ignored.items():
        checked_path(name)
        if not isinstance(reason, str) or len(reason.strip()) < 20 or name in names or (source / name).exists():
            raise BuildError("Ignored references require review and a missing legacy file")
    files, references = {}, set()
    for name in names:
        data = regular_file(source, name).read_bytes()
        for label, pattern in SECRET_PATTERNS.items():
            if re.search(pattern, data):
                raise BuildError(f"Public file rejected ({label}): {name}")
        files[name] = data
        if PurePosixPath(name).suffix in TEXT_SUFFIXES:
            try:
                references.update(local_references(data.decode("utf-8"), name))
            except UnicodeDecodeError as error:
                raise BuildError(f"Public text file is not UTF-8: {name}") from error
    unknown = references - set(names) - set(ignored)
    if unknown:
        raise BuildError("Local references not in the public manifest: " + ", ".join(sorted(unknown)))
    if set(ignored) - references:
        raise BuildError("Obsolete ignored-reference entry; review the manifest")
    unnecessary = set(names) - references - {"index.html"}
    if unnecessary:
        raise BuildError("Unreferenced assets in manifest: " + ", ".join(sorted(unnecessary)))
    return files, ignored


def verify_output(output, expected):
    output = Path(output)
    if output.is_symlink() or not output.is_dir():
        raise BuildError("Output must be a regular directory")
    actual = set()
    directories = {parent.as_posix() for name in expected for parent in PurePosixPath(name).parents if parent != PurePosixPath(".")}
    for path in output.rglob("*"):
        if path.is_symlink():
            raise BuildError("Output contains a symbolic link")
        if path.is_file():
            name = path.relative_to(output).as_posix()
            regular_file(output, name)
            actual.add(name)
        elif path.is_dir() and path.relative_to(output).as_posix() not in directories:
            raise BuildError("Output contains an unreviewed directory")
    if actual != set(expected):
        raise BuildError("Output file list differs from the reviewed manifest")
    for name, data in expected.items():
        if (output / name).read_bytes() != data:
            raise BuildError(f"Output bytes differ from the source: {name}")


def build(source, output):
    source, output = Path(source).resolve(), Path(output)
    if output.is_symlink() or output.resolve() == source or source in output.resolve().parents:
        raise BuildError("Use an output directory outside the repository")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise BuildError("Output must be new or empty; existing files are never removed")
    files, ignored = public_files(source)
    output.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    verify_output(output, files)
    return files, ignored


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.verify_only:
            files, ignored = public_files(args.source)
            verify_output(args.output, files)
        else:
            files, ignored = build(args.source, args.output)
    except (BuildError, OSError) as error:
        print(f"Pages build failed: {error}", file=sys.stderr)
        return 1
    for name, data in sorted(files.items()):
        print(f"{hashlib.sha256(data).hexdigest()}  {len(data):>8}  {name}")
    for name in ignored:
        print(f"Reviewed inactive reference (not published): {name}")
    print(f"Verified {len(files)} public files; source bytes preserved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
