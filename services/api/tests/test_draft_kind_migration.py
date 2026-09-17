from pathlib import Path
from alembic import command
from sqlalchemy import text
from app.db.engine import create_application_engine, upgrade_database, alembic_config


def test_deck_migration_preserves_existing_draft_revisions(tmp_path: Path):
    engine = create_application_engine(f"sqlite:///{tmp_path / 'migration.sqlite3'}")
    upgrade_database(engine, "20260905_0019")
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO draft_documents (id,tenant_id,owner_user_id,title,current_revision,created_at,updated_at,archived) VALUES ('draft-test','tenant-test','user-test','Saved review',2,'2026-09-01 00:00:00','2026-09-02 00:00:00',0)"))
        for revision in (1, 2):
            connection.execute(text("INSERT INTO draft_revisions (draft_id,tenant_id,owner_user_id,revision,title,content,content_sha256,sanitizer_version,created_at) VALUES ('draft-test','tenant-test','user-test',:revision,'Saved review','<p>Preserved text.</p>',:digest,'sanitized-html-v1','2026-09-02 00:00:00')"), {"revision": revision, "digest": "a" * 64})
        before = connection.execute(text("SELECT * FROM draft_revisions ORDER BY revision")).all()
    upgrade_database(engine, "20260913_0020")
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
        assert connection.execute(text("SELECT * FROM draft_revisions ORDER BY revision")).all() == before
        assert connection.execute(text("SELECT kind FROM draft_documents")).scalar_one() == "document"
    config = alembic_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "20260905_0019")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT * FROM draft_revisions ORDER BY revision")).all() == before
    engine.dispose()
