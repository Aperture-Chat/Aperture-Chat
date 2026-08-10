from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

from app.core.config import get_settings
from app.db.engine import create_application_engine
from app.db.orm import Base


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        render_as_batch=connection.dialect.name == "sqlite",
        transactional_ddl=True if connection.dialect.name == "sqlite" else None,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    database_url = get_settings().application_database_url
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
        render_as_batch=database_url.startswith("sqlite"),
        transactional_ddl=True if database_url.startswith("sqlite") else None,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    supplied_connection = config.attributes.get("connection")
    if supplied_connection is not None:
        _configure(supplied_connection)
        return

    engine = create_application_engine(get_settings().application_database_url)
    try:
        with engine.connect() as connection:
            _configure(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
