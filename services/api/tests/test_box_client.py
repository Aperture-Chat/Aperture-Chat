from __future__ import annotations

import httpx

from app.core.box import BoxClient


def test_box_client_lists_folder_items_with_pagination() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        offset = int(request.url.params.get("offset", "0"))
        if offset == 0:
            return httpx.Response(
                200,
                json={
                    "total_count": 2,
                    "entries": [
                        {
                            "id": "file-1",
                            "type": "file",
                            "name": "Motion.docx",
                            "modified_at": "2026-01-02T16:05:00-07:00",
                            "size": 8100,
                            "item_status": "active",
                            "path_collection": {"entries": [{"name": "Clients"}, {"name": "Example"}]},
                        }
                    ],
                },
            )
        return httpx.Response(
            200,
            json={
                "total_count": 2,
                "entries": [
                    {
                        "id": "folder-1",
                        "type": "folder",
                        "name": "Pleadings",
                        "item_status": "active",
                    }
                ],
            },
        )

    client = BoxClient(
        access_token="box-test-token",
        base_url="https://api.box.test/2.0",
        transport=httpx.MockTransport(handler),
    )

    items = client.list_folder_items(folder_id="123", limit=1)

    assert [item.id for item in items] == ["file-1", "folder-1"]
    assert items[0].path == "Clients/Example"
    assert [str(request.url) for request in requests] == [
        "https://api.box.test/2.0/folders/123/items?fields=id%2Ctype%2Cname%2Cmodified_at%2Csize%2Citem_status%2Cpath_collection&limit=1&offset=0",
        "https://api.box.test/2.0/folders/123/items?fields=id%2Ctype%2Cname%2Cmodified_at%2Csize%2Citem_status%2Cpath_collection&limit=1&offset=1",
    ]
    assert requests[0].headers["authorization"] == "Bearer box-test-token"


def test_box_client_downloads_file_content() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"Box file text")

    client = BoxClient(
        access_token="box-test-token",
        base_url="https://api.box.test/2.0",
        transport=httpx.MockTransport(handler),
    )

    content = client.download_file(file_id="file-1")

    assert content == b"Box file text"
    assert str(requests[0].url) == "https://api.box.test/2.0/files/file-1/content"
    assert requests[0].headers["authorization"] == "Bearer box-test-token"
