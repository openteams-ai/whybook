"""Whether a model server runs on this machine or in its network.

With ``c.Whybook.way_to_use_models = "all-local"`` the server refuses every
model that runs anywhere else (``connection.py``, ``decision_models.py``). The
address of a server's URL decides:

- the host ``localhost``, or a name that ends in ``.localhost``;
- an IP address in a loopback, private or link-local range: 127.0.0.0/8,
  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7 or
  fe80::/10;
- a host name whose every address is in those ranges, as this machine's
  resolver gives them, such as a name that a company's own DNS gives to
  10.2.0.15. The answer for a name is kept for five minutes.

Any other address, a name that does not resolve, or a URL without a host is
outside.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from urllib.parse import urlsplit

NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

# How long the answer for a host name holds, in seconds.
KEEP = 300.0

# The answers for host names: when each was looked up, and whether every address was inside.
_names: dict[str, tuple[float, bool]] = {}


def inside_address(address: str) -> bool:
    """Whether an IP address is in a loopback, private or link-local range."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in network for network in NETWORKS)


def addresses(host: str, port: int) -> list[str]:
    """The addresses of a host name that this machine's resolver gives; a test puts its own resolver here."""
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def on_network(url: str | None) -> bool:
    """Whether the server at ``url`` runs on this machine or in its network, by the address of its host."""
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host:
        return False
    host = host.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        pass
    else:
        return inside_address(host)
    kept = _names.get(host)
    if kept is not None and time.monotonic() - kept[0] < KEEP:
        return kept[1]
    try:
        found = addresses(host, port)
    except OSError:
        found = []
    inside = bool(found) and all(inside_address(address) for address in found)
    _names[host] = (time.monotonic(), inside)
    return inside
