"""CSV reading and file discovery for Oura data-export archives.

The membership-hub export is a ZIP whose ``App Data/`` folder holds one
``;``-delimited, CRLF, UTF-8 CSV per data type.  JSON-valued columns are
wrapped in standard RFC-4180 quotes with doubled inner quotes, so the file
must be read with a real CSV parser -- never by splitting on the delimiter.

Older/alternate exports have been reported flat (no ``App Data`` folder), with
comma delimiters, with renamed files (``sleep.csv`` instead of
``sleepmodel.csv``, ``tag.csv`` instead of ``enhancedtag.csv``) and with a
``_YYYY-MM-DD[_YYYY-MM-DD]`` suffix.  All of those are accepted here.
"""
from __future__ import annotations

import csv
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Wide JSON blobs (``met``, ``heart_rate``...) exceed csv's default 128 kB limit.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

# Logical data type -> accepted file stems (lower-case, without suffix/extension).
FILE_ALIASES: Dict[str, Tuple[str, ...]] = {
    "dailysleep": ("dailysleep",),
    "sleeptime": ("sleeptime",),
    "dailyspo2": ("dailyspo2",),
    "dailyreadiness": ("dailyreadiness",),
    "dailystress": ("dailystress",),
    "dailyactivity": ("dailyactivity",),
    "dailyresilience": ("dailyresilience",),
    "daytimestress": ("daytimestress",),
    "sleep_session": ("sleepmodel", "sleep"),
    "workout": ("workout",),
    "session": ("session",),
    "heartrate": ("heartrate",),
    "temperature": ("temperature",),
    "ringconfiguration": ("ringconfiguration",),
    "tag": ("enhancedtag", "tag"),
    "dailycardiovascularage": ("dailycardiovascularage",),
    "ringbatterylevel": ("ringbatterylevel",),
    "vo2max": ("vo2max",),
}

_STEM_TO_TYPE: Dict[str, str] = {
    stem: dtype for dtype, stems in FILE_ALIASES.items() for stem in stems
}

# ``dailysleep.csv``, ``dailysleep_2024-01-01.csv``, ``dailysleep_2024-01-01_2024-12-31.csv``
_NAME_RE = re.compile(
    r"^(?P<stem>[a-z0-9]+)(?:_\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?)?\.csv$"
)

_SKIP_DIRS = {"__macosx"}


def classify_filename(name: str) -> Optional[str]:
    """Return the logical data type for a CSV file name, or None if unknown."""
    m = _NAME_RE.match(os.path.basename(name).lower())
    if not m:
        return None
    return _STEM_TO_TYPE.get(m.group("stem"))


def discover_files(root: str) -> Dict[str, List[str]]:
    """Recursively find every known export CSV under ``root``.

    Returns ``{data_type: [absolute paths, sorted]}``.  Multiple files of the
    same type (date-suffixed splits) are all returned so the caller can
    concatenate them.  ``__MACOSX`` folders and ``._*`` resource forks are
    ignored.
    """
    found: Dict[str, List[str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d.lower() not in _SKIP_DIRS)
        for fn in sorted(filenames):
            if fn.startswith("._"):
                continue
            dtype = classify_filename(fn)
            if dtype:
                found.setdefault(dtype, []).append(os.path.join(dirpath, fn))
    if found:
        folders = sorted({os.path.dirname(p) for paths in found.values() for p in paths})
        logger.info("Found %d export file type(s) in %s", len(found), ", ".join(folders))
    return found


@dataclass
class CsvResult:
    path: str
    columns: List[str] = field(default_factory=list)
    rows: List[Dict[str, str]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    delimiter: str = ";"

    @property
    def name(self) -> str:
        return os.path.basename(self.path)


def sniff_delimiter(header_line: str) -> str:
    """Pick ``;`` or ``,`` from the header line (header names never contain either)."""
    semis = header_line.count(";")
    commas = header_line.count(",")
    if semis == 0 and commas == 0:
        return ";"
    return ";" if semis >= commas else ","


def read_csv(path: str) -> CsvResult:
    """Read one export CSV into a list of ``{column: str}`` dicts.

    * Delimiter is sniffed from the header line (``;`` preferred over ``,``).
    * A UTF-8 BOM is stripped (``utf-8-sig``).
    * Quoted fields may contain the delimiter, doubled quotes and newlines
      (CRLF inside a value is normalised to LF).
    * Column names are lower-cased and stripped; values are kept as strings
      (empty string for an empty ``;;`` field or a short row).
    * A malformed row is skipped and recorded in ``warnings``; the rows already
      read are kept.
    """
    result = CsvResult(path=path)
    name = result.name
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        header_line = fh.readline()
        if not header_line.strip():
            result.warnings.append(f"{name}: empty file")
            return result
        delimiter = sniff_delimiter(header_line)
        result.delimiter = delimiter
        columns = [c.strip().strip('"').strip().lower() for c in next(csv.reader([header_line], delimiter=delimiter))]
        result.columns = columns
        ncols = len(columns)

        reader = csv.reader(fh, delimiter=delimiter, quotechar='"', doublequote=True, strict=False)
        while True:
            try:
                raw = next(reader)
            except StopIteration:
                break
            except csv.Error as exc:  # malformed row: skip it, keep going
                result.warnings.append(f"{name}: skipped malformed row near line {reader.line_num}: {exc}")
                continue
            if not raw or all(not c.strip() for c in raw):
                continue
            if len(raw) < ncols:
                raw = raw + [""] * (ncols - len(raw))
            elif len(raw) > ncols:
                result.warnings.append(
                    f"{name}: row {reader.line_num} has {len(raw)} fields, expected {ncols}; extra fields dropped"
                )
                raw = raw[:ncols]
            result.rows.append({col: val.replace("\r\n", "\n").strip() for col, val in zip(columns, raw)})
    logger.debug("%s: %d rows, delimiter %r, columns %s", name, len(result.rows), delimiter, columns)
    return result


def read_many(paths: Iterable[str]) -> Tuple[List[Dict[str, str]], Dict[str, object], List[str]]:
    """Read and concatenate several files of one data type.

    Returns ``(rows, per_file, warnings)`` where ``per_file`` maps the file
    name to the number of rows read or to an ``"error: ..."`` string.  A file
    that cannot be read at all does not abort the others.
    """
    rows: List[Dict[str, str]] = []
    per_file: Dict[str, object] = {}
    warnings: List[str] = []
    for p in paths:
        name = os.path.basename(p)
        try:
            res = read_csv(p)
        except Exception as exc:  # unreadable file: report and move on
            logger.exception("Failed to read %s", name)
            per_file[name] = f"error: {exc}"
            warnings.append(f"{name}: could not be read ({exc})")
            continue
        rows.extend(res.rows)
        per_file[name] = len(res.rows)
        warnings.extend(res.warnings)
    return rows, per_file, warnings
