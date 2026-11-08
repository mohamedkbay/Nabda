#!/usr/bin/env python3
"""Nabda 0.2.0 application client. Python 3 standard library only."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def base_origin():
    raw = os.environ.get("NABDA_BASE_URL", "")
    parsed = urllib.parse.urlsplit(raw)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("Set NABDA_BASE_URL to an HTTPS origin, without credentials, path, query or fragment.")
    loopback = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("Use HTTPS. HTTP is allowed only for loopback development.")
    return raw.rstrip("/")


def parser():
    app = argparse.ArgumentParser(description="Nabda client: sandbox sends by default, no automatic retries. Credentials: NABDA_API_KEY environment variable only.")
    sub = app.add_subparsers(dest="command", required=True)
    sub.add_parser("health", help="Read unauthenticated health; no SMS")
    sub.add_parser("usage", help="Read workspace command and device-reported counters")
    for name in ("status", "cancel"):
        sub.add_parser(name).add_argument("--id", required=True, help="Message ID returned by Nabda")
    send = sub.add_parser("send", help="Create a sandbox command unless --live is explicit")
    send.add_argument("--content-file", required=True, help="UTF-8 text file; whitespace preserved")
    send.add_argument("--idempotency-key", required=True, help="8–128 printable non-space ASCII characters; reuse with identical payload after timeout")
    send.add_argument("--to", help="Recipient; falls back to NABDA_TO")
    send.add_argument("--send-at", help="RFC3339 timestamp including timezone")
    send.add_argument("--expires-at", help="RFC3339 timestamp including timezone")
    send.add_argument("--live", action="store_true", help="Explicitly set sandbox=false; carrier charges may apply")
    return app


def main():
    args = parser().parse_args()
    method, payload, request_id = "GET", None, None
    if args.command in ("health", "usage"):
        endpoint = "/health" if args.command == "health" else "/v1/usage"
    elif args.command in ("status", "cancel"):
        if len(args.id) > 80 or re.search(r"[\s/\\?#]", args.id):
            raise ValueError("Use the message ID returned by Nabda.")
        endpoint = "/v1/messages/" + urllib.parse.quote(args.id, safe="")
        if args.command == "cancel":
            endpoint += "/cancellations"
            method, payload = "POST", {}
    else:
        content = Path(args.content_file).read_bytes().decode("utf-8")
        if not content.strip() or len(content.encode("utf-16-le")) // 2 > 4000:
            raise ValueError("Message must contain 1–4,000 UTF-16 units.")
        if not re.fullmatch(r"[\x21-\x7e]{8,128}", args.idempotency_key):
            raise ValueError("Use a stable Idempotency-Key of 8–128 printable non-space ASCII characters.")
        device = os.environ.get("NABDA_DEVICE_ID", "")
        to = args.to or os.environ.get("NABDA_TO", "")
        if not device or len(device) > 80 or not to.strip():
            raise ValueError("Set NABDA_DEVICE_ID and NABDA_TO (or --to).")
        payload = {"device_id": device, "to": to, "content": content, "sandbox": not args.live}
        if args.send_at:
            payload["send_at"] = args.send_at
        if args.expires_at:
            payload["expires_at"] = args.expires_at
        if args.live:
            print("Live request: sandbox=false. Carrier charges may apply; 202 means accepted, not sent.", file=sys.stderr)
        endpoint, method, request_id = "/v1/messages", "POST", args.idempotency_key
    headers = {"Accept": "application/json", "User-Agent": "Nabda-Free-Starter/0.2.0"}
    credential = ""
    if args.command != "health":
        credential = os.environ.get("NABDA_API_KEY", "")
        if not re.fullmatch(r"nb_app_[a-f0-9]{64}", credential):
            raise ValueError("Set NABDA_API_KEY to an application key from the dashboard.")
        headers["Authorization"] = "Bearer " + credential
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if request_id:
        headers["Idempotency-Key"] = request_id
    request = urllib.request.Request(base_origin() + endpoint, data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError):
        raise ValueError("Request failed or timed out. For send, retry with the identical Idempotency-Key and payload.") from None
    with response:
        status = response.code
        try:
            result = json.loads(response.read().decode("utf-8"))
        except (ValueError, UnicodeError):
            raise ValueError("Expected JSON. Check NABDA_BASE_URL and proxy configuration.") from None
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if credential:
        output = output.replace(credential, "[REDACTED]")
    print(output)
    if not 200 <= status < 300:
        print("HTTP {}. See README.md for error handling.".format(status), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError):
        print("Nabda client failed. Check command options, environment, input file and network. Run --help for usage.", file=sys.stderr)
        sys.exit(1)
