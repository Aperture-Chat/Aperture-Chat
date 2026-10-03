"""Stdlib SMTP delivery for alert notifications and test sends.

Deliberately synchronous and blocking: callers are the scheduler pass (which
already runs inside ``asyncio.to_thread``) and the owner's explicit test-send
route (a sync route served from FastAPI's threadpool). It is never called
from ``record_audit`` or any completion path — alert evaluation only queues.

Every failure is re-raised as ``MailerError`` carrying the real error text so
callers can record honest delivery status; nothing here fakes success.
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from app.models.schemas import EmailSettings

SMTP_TIMEOUT_SECONDS = 15.0


class MailerError(Exception):
    """A real SMTP failure (connection, auth, or recipient rejection)."""


def email_configured(settings: EmailSettings) -> bool:
    return bool(settings.host.strip() and settings.from_address.strip())


def _tls_context() -> ssl.SSLContext:
    # smtplib's own default context skips certificate and hostname checks,
    # which would hand the vaulted SMTP password to anyone able to intercept
    # the connection. Verify against the system trust store instead.
    return ssl.create_default_context()


def _message_id_domain(from_address: str) -> str | None:
    _, _, domain = from_address.rpartition("@")
    return domain.strip() or None


def send_email(
    *,
    host: str,
    port: int,
    security: str,
    username: str,
    password: str | None,
    from_address: str,
    recipients: list[str],
    subject: str,
    body_text: str,
) -> None:
    if not recipients:
        raise MailerError("No recipients were provided.")
    message = EmailMessage()
    message["From"] = from_address
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    # smtplib adds neither header; relays and spam filters penalize mail
    # that arrives without them.
    message["Date"] = formatdate(localtime=False, usegmt=True)
    message["Message-ID"] = make_msgid(domain=_message_id_domain(from_address))
    message.set_content(body_text)

    try:
        if security == "ssl":
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(
                host, port, timeout=SMTP_TIMEOUT_SECONDS, context=_tls_context()
            )
        else:
            smtp = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_SECONDS)
        try:
            if security == "starttls":
                smtp.starttls(context=_tls_context())
            if username:
                smtp.login(username, password or "")
            smtp.send_message(message)
        finally:
            try:
                smtp.quit()
            except Exception:  # noqa: BLE001 - close failures must not mask the send result
                pass
    except MailerError:
        raise
    except Exception as exc:  # noqa: BLE001 - surface the real SMTP error text
        raise MailerError(str(exc) or exc.__class__.__name__) from exc
