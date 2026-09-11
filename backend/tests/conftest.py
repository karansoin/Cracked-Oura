import os
import sys
import tempfile

# Every test runs against an isolated data directory.
os.environ.setdefault("CRACKED_OURA_DATA_DIR", tempfile.mkdtemp(prefix="cracked-oura-test-"))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
