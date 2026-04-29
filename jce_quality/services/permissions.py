from __future__ import annotations

import frappe
from frappe import _


QUALITY_READ_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager", "Manufacturing User")
QUALITY_EXECUTION_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager", "Manufacturing User")
QUALITY_ANALYTICS_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager")
QUALITY_DISPOSITION_ROLES = ("System Manager", "Quality Manager")


def require_quality_read_access():
	_require_any_role(QUALITY_READ_ROLES)


def require_quality_execution_access():
	_require_any_role(QUALITY_EXECUTION_ROLES)


def require_quality_analytics_access():
	_require_any_role(QUALITY_ANALYTICS_ROLES)


def require_quality_disposition_access():
	_require_any_role(QUALITY_DISPOSITION_ROLES)


def _require_any_role(allowed_roles: tuple[str, ...]):
	if frappe.session.user == "Administrator":
		return

	user_roles = set(frappe.get_roles())
	if user_roles.intersection(allowed_roles):
		return

	frappe.throw(_("Not permitted to access production quality data."), frappe.PermissionError)
