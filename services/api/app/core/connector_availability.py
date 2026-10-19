"""Whether a connector is on, and offered, inside one workspace.

The connector catalog is deployment-wide. Its two flags together are the
platform owner's ceiling: when either is off, no workspace can use the
connector. Below that ceiling each workspace's administrators decide through
the tenant's own connector configuration records:

- ``enabled`` is the workspace switch. Capability connectors (web search, MCP,
  the prompt library) stay on until an admin records otherwise. Cloud file
  sources additionally need an enabled record holding their credentials,
  which the cloud attachment routes check themselves.
- ``hidden`` drops a cloud file source from the attach menus without turning
  it off, so knowledge sync can keep running on its credentials while people
  never see the source as something to pick.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.models.schemas import ConnectorConfig

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore

# Catalog ids behind the chat and Drafts "attach from source" menus. Only these
# can be hidden; other connectors never appear there.
ATTACHABLE_CONNECTOR_IDS = frozenset({"google-drive", "microsoft-graph", "box", "imanage"})


def tenant_connector_configs(
    store: SeedStore, connector_id: str, tenant_id: str | None
) -> list[ConnectorConfig]:
    if tenant_id is None:
        return []
    return [
        config
        for config in store.connector_configs.values()
        if config.connector_id == connector_id and config.tenant_id == tenant_id
    ]


def connector_allowed_for_deployment(store: SeedStore, connector_id: str) -> bool:
    connector = store.connectors.get(connector_id)
    return connector is not None and connector.platform_enabled and connector.tenant_enabled


def connector_enabled_for_tenant(store: SeedStore, connector_id: str, tenant_id: str | None) -> bool:
    if not connector_allowed_for_deployment(store, connector_id):
        return False
    records = tenant_connector_configs(store, connector_id, tenant_id)
    return any(record.enabled for record in records) if records else True


def connector_hidden_for_tenant(store: SeedStore, connector_id: str, tenant_id: str | None) -> bool:
    return any(record.hidden for record in tenant_connector_configs(store, connector_id, tenant_id))
