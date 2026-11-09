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
    prepare_database()

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
