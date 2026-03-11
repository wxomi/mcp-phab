#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from typing import Any

CONDUIT_URI = "https://phab.instahyre.com/"


def call_conduit(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    cmd = [
        "arc",
        "call-conduit",
        "--conduit-uri",
        CONDUIT_URI,
        "--",
        method,
    ]
    proc = subprocess.run(
        cmd,
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{method} failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'replace').strip()}")
    try:
        raw = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{method} returned invalid JSON: {exc}") from exc

    if raw.get("error") is not None:
        raise RuntimeError(f"{method} conduit error: {raw.get('error')}")
    if raw.get("error_code") is not None:
        raise RuntimeError(f"{method} conduit error_code: {raw.get('error_code')} ({raw.get('error_info')})")

    if isinstance(raw.get("response"), dict):
        return raw["response"]
    if isinstance(raw.get("result"), dict):
        return raw["result"]
    return raw


def parse_revision_id(value: str) -> int:
    match = re.fullmatch(r"[dD]?(\d+)", value.strip())
    if not match:
        raise ValueError("revision id must be like D35079 or 35079")
    return int(match.group(1))


def parse_files_from_rawdiff(rawdiff: str) -> list[str]:
    files: list[str] = []
    seen: set[str] = set()
    for line in rawdiff.splitlines():
        path = None
        m = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
        if m:
            path = m.group(2)
        if path is None:
            m = re.match(r"^Index:\s+(.+)$", line)
            if m:
                path = m.group(1)
        if path is None:
            m = re.match(r"^\+\+\+\s+b/(.+)$", line)
            if m:
                path = m.group(1)
        if not path or path == "/dev/null" or path in seen:
            continue
        seen.add(path)
        files.append(path)
    return files


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/check_revision_context.py D35079", file=sys.stderr)
        return 2

    rev_id = parse_revision_id(sys.argv[1])

    rev = call_conduit(
        "differential.revision.search",
        {"constraints": {"ids": [rev_id]}, "attachments": {"diffs": True}, "limit": 1},
    )
    data = rev.get("data") or []
    if not data:
        print(json.dumps({"revisionId": f"D{rev_id}", "found": False}, indent=2))
        return 0

    item = data[0]
    fields = item.get("fields") or {}
    attachments = item.get("attachments") or {}
    diffs_attachment = attachments.get("diffs") if isinstance(attachments, dict) else {}
    if not isinstance(diffs_attachment, dict):
        diffs_attachment = {}
    status = fields.get("status") or {}
    diff_phid = fields.get("diffPHID")
    diff_phids = []
    if isinstance(diff_phid, str):
        diff_phids.append(diff_phid)
    for p in (diffs_attachment.get("diffPHIDs") or []):
        if isinstance(p, str) and p not in diff_phids:
            diff_phids.append(p)

    diff_ids = [d for d in (fields.get("diffs") or []) if isinstance(d, int) and d > 0]
    for d in (diffs_attachment.get("diffIDs") or []):
        if isinstance(d, int) and d > 0 and d not in diff_ids:
            diff_ids.append(d)

    if not diff_ids and diff_phids:
        try:
            ds = call_conduit(
                "differential.diff.search",
                {"constraints": {"phids": diff_phids}, "limit": max(10, len(diff_phids))},
            )
            for entry in (ds.get("data") or []):
                did = entry.get("id") if isinstance(entry, dict) else None
                if isinstance(did, int) and did > 0 and did not in diff_ids:
                    diff_ids.append(did)
        except Exception:
            pass
    summary = fields.get("summary")
    if isinstance(summary, dict):
        summary = summary.get("raw") or summary.get("text") or summary.get("content")

    out: dict[str, Any] = {
        "revisionId": f"D{rev_id}",
        "found": True,
        "title": fields.get("title"),
        "summary": summary,
        "uri": fields.get("uri"),
        "diffPHID": diff_phid,
        "diffPHIDs": diff_phids,
        "status": status,
        "diffIDs": diff_ids,
    }

    changed_files: list[str] = []
    warnings: list[str] = []

    if diff_phids:
        for current_phid in diff_phids:
            try:
                cs = call_conduit(
                    "differential.changeset.search",
                    {"constraints": {"diffPHIDs": [current_phid]}, "limit": 1000},
                )
                cs_data = cs.get("data") or []
                for c in cs_data:
                    c_fields = c.get("fields") or {}
                    path = c_fields.get("path") or c.get("path")
                    if isinstance(path, str):
                        changed_files.append(path)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"changeset search failed for {current_phid}: {exc}")
        changed_files = sorted(set(changed_files))
        if not changed_files:
            warnings.append("changeset search returned 0 files")
    else:
        warnings.append("missing diffPHIDs")

    if not changed_files and diff_ids:
        raw_files: list[str] = []
        for diff_id in diff_ids:
            try:
                rd = call_conduit("differential.getrawdiff", {"diffID": diff_id})
                raw = rd.get("response") or rd.get("rawDiff") or rd.get("diff")
                if isinstance(raw, str):
                    raw_files.extend(parse_files_from_rawdiff(raw))
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"getrawdiff failed for {diff_id}: {exc}")
        changed_files = sorted(set(raw_files))
        if not changed_files:
            warnings.append("rawdiff fallback returned 0 files")
    elif not changed_files and not diff_ids:
        warnings.append("no diff IDs available for rawdiff fallback")

    out["changedFiles"] = changed_files
    if warnings:
        out["warnings"] = warnings

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
