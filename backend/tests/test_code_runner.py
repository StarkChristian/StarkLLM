"""The chat's "Run" button executes Python code blocks. The runner used to execute anything with the server's privileges,
environment and no limits at all, while the website promised an AST check and memory/time limits."""
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.system import ExecuteCodeRequest, check_code, execute_code


def run(code, timeout=5, language="python"):
    return execute_code(ExecuteCodeRequest(code=code, language=language, timeout_seconds=timeout), current_user=None)


def test_plain_code_runs():
    r = run("print(sum(range(10)))\nimport math\nprint(round(math.pi, 2))")
    assert r["exit_code"] == 0 and r["stdout"].split() == ["45", "3.14"]


@pytest.mark.parametrize("language", ["python", "py", "python3"])
def test_language_names_used_by_the_chat_ui_are_accepted(language):
    assert run("print(1)", language=language)["exit_code"] == 0


@pytest.mark.parametrize("code", [
    "import os\nprint(os.environ)",
    "from subprocess import run",
    "import socket",
    "open('/etc/passwd').read()",
    "eval('1+1')",
    "__import__('os')",
    "().__class__.__bases__[0].__subclasses__()",
    "getattr(print, '__self__')",
])
def test_dangerous_code_is_blocked_before_it_starts(code):
    assert check_code(code)
    r = run(code)
    assert r["exit_code"] == 126 and r["stderr"].startswith("Blocked:")


def test_syntax_errors_are_reported_by_python_itself():
    r = run("print(")
    assert r["exit_code"] != 0 and "SyntaxError" in r["stderr"]


def test_endless_loop_is_stopped():
    r = run("while True:\n    pass", timeout=1)
    assert r["exit_code"] != 0


@pytest.mark.skipif(os.name != "posix", reason="memory limit uses resource.setrlimit")
def test_memory_hog_is_stopped():
    r = run("x = bytearray(2 * 1024 * 1024 * 1024)\nprint(len(x))")
    assert r["exit_code"] != 0 and "2147483648" not in r["stdout"]


def test_other_languages_and_huge_snippets_are_rejected():
    with pytest.raises(HTTPException) as e:
        run("console.log(1)", language="javascript")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        run("x = 1\n" * 10000)
    assert e.value.status_code == 413


def test_numpy_and_pandas_work_under_the_memory_limit():
    """Found by a smoke test of the merged build: with several BLAS threads numpy/pandas could not even be imported
    under the address-space limit ('OpenBLAS error: Memory allocation still failed')."""
    pytest.importorskip("numpy")
    pytest.importorskip("pandas")
    r = run("import numpy as np, pandas as pd\nprint(np.arange(5).sum(), pd.DataFrame({'a': [1, 2]}).a.sum())", timeout=10)
    assert r["exit_code"] == 0 and r["stdout"].split() == ["10", "3"], r
