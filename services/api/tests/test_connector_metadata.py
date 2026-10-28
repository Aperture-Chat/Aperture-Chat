"""Cloud connectors keep the metadata their systems hold about each file.

Box metadata templates, Box Shield classifications, SharePoint columns, and
Google Drive properties are where firms record matters, classifications, and
ethical walls; none of that is inside the downloaded file. Synthetic data only.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.box import BoxClient, BoxItem
from app.core.cloud_sources import _google_item, _graph_item
from app.main import app
from app.models.schemas import Group
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _box(handler) -> BoxClient:
    return BoxClient(
        access_token="box-test-token",
        base_url="https://api.box.test/2.0",
        transport=httpx.MockTransport(handler),
    )


def test_box_listing_keeps_owner_description_tags_and_classification() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        fields = request.url.params["fields"].split(",")
        assert {"description", "tags", "created_by", "owned_by", "classification"} <= set(fields)
        return httpx.Response(
            200,
            json={
                "total_count": 1,
                "entries": [
                    {
                        "id": "file-1",
                        "type": "file",
                        "name": "Falcon SPA.docx",
                        "description": "Signing version",
                        "tags": ["falcon", "spa"],
                        "created_at": "2026-01-02T10:00:00-07:00",
                        "created_by": {"type": "user", "name": "Avery Example"},
                        "owned_by": {"type": "user", "name": "Deal Ops"},
                        "classification": {"name": "Confidential", "color": "#f00"},
                    }
                ],
            },
        )

    [item] = _box(handler).list_folder_items(folder_id="123")
    assert dict(item.properties) == {
        "Description": "Signing version",
        "Tags": "falcon, spa",
        "Created": "2026-01-02T10:00:00-07:00",
        "Created by": "Avery Example",
        "Owner": "Deal Ops",
        "Box classification": "Confidential",
    }


def test_box_file_metadata_flattens_every_template_instance() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/2.0/files/file-1/metadata"
        return httpx.Response(
            200,
            json={
                "entries": [
                    {
                        "$template": "properties",
                        "$scope": "global",
                        "$id": "x",
                        "Matter number": "20419",
                    },
                    {
                        "$template": "matterInfo",
                        "$scope": "enterprise_1",
                        "$canEdit": True,
                        "ethicalWall": "Project Falcon",
                        "practiceAreas": ["M&A", "Tax"],
                        "budget": 12000,
                    },
                    {
                        "$template": "securityClassification-6VMVochwUWo",
                        "$scope": "enterprise_1",
                        "Box__Security__Classification__Key": "Highly Confidential",
                    },
                ]
            },
        )

    assert _box(handler).file_metadata(file_id="file-1") == [
        ("Matter number", "20419"),
        ("matterInfo · ethicalWall", "Project Falcon"),
        ("matterInfo · practiceAreas", "M&A, Tax"),
        ("matterInfo · budget", "12000"),
        ("Box classification", "Highly Confidential"),
    ]


def test_box_file_metadata_failure_is_empty_not_an_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"code": "forbidden"})

    assert _box(handler).file_metadata(file_id="file-1") == []


def test_graph_item_keeps_people_dates_description_and_sharepoint_columns() -> None:
    item = _graph_item(
        {
            "id": "item-1",
            "name": "Falcon SPA.docx",
            "file": {"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
            "description": "Execution copy",
            "createdDateTime": "2026-01-02T10:00:00Z",
            "createdBy": {"user": {"displayName": "Avery Example"}},
            "lastModifiedBy": {"user": {"displayName": "Jordan Sample"}},
            "listItem": {
                "fields": {
                    "@odata.etag": "\"1\"",
                    "id": "7",
                    "ContentType": "Document",
                    "FileLeafRef": "Falcon SPA.docx",
                    "AuthorLookupId": "12",
                    "_UIVersionString": "3.0",
                    "_ComplianceTag": "Legal hold",
                    "EthicalWall": "Project Falcon",
                    "MatterNumber": 20419,
                    "Privileged": True,
                    "Parties": ["Falcon Inc", "Osprey LLC"],
                }
            },
        }
    )
    assert item is not None
    assert dict(item.properties) == {
        "Description": "Execution copy",
        "Created": "2026-01-02T10:00:00Z",
        "Created by": "Avery Example",
        "Last modified by": "Jordan Sample",
        "Retention label": "Legal hold",
        "EthicalWall": "Project Falcon",
        "MatterNumber": "20419",
        "Privileged": "Yes",
        "Parties": "Falcon Inc, Osprey LLC",
    }


def test_google_item_keeps_owners_description_and_custom_properties() -> None:
    item = _google_item(
        {
            "id": "g-1",
            "name": "Falcon SPA",
            "mimeType": "application/vnd.google-apps.document",
            "description": "Shared with deal team",
            "createdTime": "2026-01-02T10:00:00Z",
            "owners": [{"displayName": "Avery Example"}],
            "lastModifyingUser": {"displayName": "Jordan Sample"},
            "properties": {"ethical_wall": "Project Falcon"},
            "appProperties": {"matter": "20419"},
        }
    )
    assert item is not None
    assert dict(item.properties) == {
        "Description": "Shared with deal team",
        "Created": "2026-01-02T10:00:00Z",
        "Owner": "Avery Example",
        "Last modified by": "Jordan Sample",
        "ethical_wall": "Project Falcon",
        "matter": "20419",
    }


def test_box_sync_stores_metadata_and_applies_the_ethical_wall(monkeypatch) -> None:
    store = get_store()
    store.groups["group-falcon"] = Group(
        id="group-falcon",
        tenant_id="tenant-example",
        name="Project Falcon",
        distinguished_name="CN=Project Falcon",
        entra_object_id="group-falcon",
    )
    connector = store.connector_configs["conncfg-box-example"]
    connector.auth_type = "developer-token"
    connector.settings["auth_mode"] = "developer-token"
    connector.settings["folder_id"] = "12345"
    store.set_configuration_secret("connector", "conncfg-box-example", "box-live-token")

    class FakeBoxClient:
        def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
            return [
                BoxItem(
                    id="987",
                    type="file",
                    name="Falcon memo.txt",
                    properties=(("Created by", "Avery Example"),),
                ),
                BoxItem(id="988", type="file", name="Engagement letter.txt"),
            ]

        def download_file(self, *, file_id: str) -> bytes:
            return {
                "987": b"Kestrel valuation: the Falcon price is 42 million.",
                "988": b"Kestrel engagement letter and hourly terms.",
            }[file_id]

        def file_metadata(self, *, file_id: str) -> list[tuple[str, str]]:
            return [("matterInfo · ethicalWall", "Project Falcon")] if file_id == "987" else []

    monkeypatch.setattr("app.routes.knowledge.get_box_client", lambda _token: FakeBoxClient())
    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers={"x-aperture-user": "user-admin"},
    )
    assert response.status_code == 200, response.text
    documents = {item["id"]: item for item in response.json()["documents"]}
    walled = documents["doc-box-987"]
    assert walled["metadata"]["Created by"] == "Avery Example"
    assert walled["metadata"]["matterInfo · ethicalWall"] == "Project Falcon"
    assert walled["wall"]["group_ids"] == ["group-falcon"]
    assert documents["doc-box-988"]["wall"] is None

    jane = store.users["user-jane"]
    hits = store.retrieve_knowledge(jane, ["knowledge-box-matters"], "Kestrel", limit=10)
    assert {hit.document_id for hit in hits} == {"doc-box-988"}


def test_graph_listing_retries_without_columns_when_the_drive_has_no_list_items() -> None:
    from app.core.cloud_sources import MicrosoftGraphClient

    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        expand = request.url.params.get("$expand")
        seen.append(expand)
        if expand:
            return httpx.Response(400, json={"error": {"code": "invalidRequest"}})
        return httpx.Response(200, json={"value": [{"id": "a", "name": "a.txt", "file": {}}]})

    graph = MicrosoftGraphClient(
        access_token="graph-test-token",
        base_url="https://graph.example.test/v1.0",
        transport=httpx.MockTransport(handler),
    )
    items = graph.list_drive_items(item_id="root", drive_id="drive-1")
    assert [item.id for item in items] == ["a"]
    assert seen == ["listItem($expand=fields)", None]


def test_graph_listing_does_not_retry_other_failures() -> None:
    from app.core.cloud_sources import CloudSourceError, MicrosoftGraphClient

    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(403, json={})

    graph = MicrosoftGraphClient(
        access_token="graph-test-token",
        base_url="https://graph.example.test/v1.0",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(CloudSourceError, match="HTTP 403"):
        graph.list_drive_items(item_id="root", drive_id="drive-1")
    assert len(calls) == 1


def test_imanage_item_keeps_profile_and_custom_fields() -> None:
    from app.core.cloud_sources import _imanage_item

    item = _imanage_item(
        {
            "id": "ACTIVE!123.1",
            "name": "Falcon SPA",
            "author": "AEXAMPLE",
            "class": "AGREEMENT",
            "custom1": "20419",
            "custom2": "Project Falcon",
            "customer": {"nested": True},
            "custom_label": "ignored",
        },
        workspace_id="ws-1",
    )
    assert item is not None
    assert dict(item.properties) == {
        "Author": "AEXAMPLE",
        "Class": "AGREEMENT",
        "custom1": "20419",
        "custom2": "Project Falcon",
    }


def test_google_item_ignores_an_unreadable_size_and_marks_folders() -> None:
    folder = _google_item(
        {"id": "f", "name": "Deals", "mimeType": "application/vnd.google-apps.folder", "size": "n/a"}
    )
    assert folder is not None
    assert folder.type == "folder" and folder.size is None and folder.properties == ()
    assert _google_item({"id": 7, "name": "x"}) is None
