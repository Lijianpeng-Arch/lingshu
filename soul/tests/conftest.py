"""Pytest 全局 fixtures。"""

import sys
from pathlib import Path

# 确保 src/ 在 Python 路径里
_src = Path(__file__).parent.parent / "src"
if str(_src) not in sys.path:
    sys.path.insert(0, str(_src))
