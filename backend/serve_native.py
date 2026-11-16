"""Start the StarkLLM engine without Docker (roadmap phase 2).

The desktop app runs it with the bundled Python of the Windows engine package:

    runtime\\python.exe backend\\serve_native.py --port 8000

It does what the Docker container does at start (create the tables, run the migrations, start uvicorn). The working
directory is the user's StarkLLM folder (%APPDATA%\\StarkLLM): the engine keeps its data in .\\data there, which is the
same folder the Docker engine uses as its volume, so chats and documents carry over between the two.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)


def use_bundled_tesseract(package=PACKAGE, env=os.environ):
    """The package brings Tesseract (OCR) in tesseract\\; the OCR service finds it through these variables.
    A Tesseract set in STARKLLM_TESSERACT wins."""
    exe = os.path.join(package, "tesseract", "tesseract.exe")
    if env.get("STARKLLM_TESSERACT") or not os.path.isfile(exe):
        return False
    env["STARKLLM_TESSERACT"] = exe
    env["TESSDATA_PREFIX"] = os.path.join(package, "tesseract", "tessdata")
    return True


def use_bundled_models(package=PACKAGE, env=os.environ):
    """The package brings the search reranker's model in models\\ (the Docker image has it in /opt/starkllm-models), so
    it is never fetched from the internet on the user's PC and search works fully offline from the first start."""
    models = os.path.join(package, "models")
    if env.get("STARKLLM_RERANKER_DIR") or not os.path.isdir(os.path.join(models, "ms-marco-TinyBERT-L-2-v2")):
        return False
    env["STARKLLM_RERANKER_DIR"] = models
    return True


def use_pycache_folder(env=os.environ, sys_module=sys):
    """Python's bytecode cache goes to the folder the desktop app names (STARKLLM_PYCACHE, under
    %LOCALAPPDATA%\\StarkLLM\\engine\\pycache), never into the installed program folder: that folder is the
    installer's, may be read-only (installed for all users), and an update replaces it. The variable has its own name
    because the package's python311._pth puts Python in isolated mode, which ignores PYTHONPYCACHEPREFIX."""
    folder = env.get("STARKLLM_PYCACHE")
    if not folder:
        return False
    sys_module.pycache_prefix = folder
    return True


def prepare_database():
    from app.db.session import engine, Base
    import app.db.models  # noqa: F401  (registers the tables)

    Base.metadata.create_all(bind=engine)

    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(HERE, "alembic.ini"))
    # alembic.ini names its folder relative to the working directory, which is the data folder here
    cfg.set_main_option("script_location", os.path.join(HERE, "alembic"))
    command.upgrade(cfg, "head")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start the StarkLLM engine without Docker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    os.makedirs("data", exist_ok=True)
    use_pycache_folder()
    use_bundled_tesseract()
    use_bundled_models()
    prepare_database()

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
