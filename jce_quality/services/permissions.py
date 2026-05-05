from __future__ import annotations

import frappe
from frappe import _


QUALITY_READ_ROLES = ("System Manager", "Quality Manager", "Quality User", "Manufacturing Manager", "Manufacturing User")
QUALITY_EXECUTION_ROLES = ("System Manager", "Quality Manager", "Quality User")
QUALITY_ANALYTICS_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager")
QUALITY_DISPOSITION_ROLES = ("System Manager", "Quality Manager")
DMR_STOCK_ROLES = ("Stock Manager", "Stock User")
QUALITY_GATE_DIRECT_OVERRIDE_ROLE = "JCE Quality Gate Override"
TERMINAL_ACTION_DEFAULT_ROLES = {
	"Temporary Continue": ("System Manager", "Quality Manager", "Quality User"),
	"Disposition": ("System Manager", "Quality Manager"),
	"Concession Approval": ("System Manager", "Quality Manager"),
}


def require_quality_read_access():
	_require_any_role(QUALITY_READ_ROLES)


def require_quality_execution_access():
	_require_any_role(QUALITY_EXECUTION_ROLES)


def require_quality_analytics_access():
	_require_any_role(QUALITY_ANALYTICS_ROLES)


def require_quality_disposition_access():
	require_terminal_action_access("Disposition")


def has_quality_disposition_access() -> bool:
	return has_terminal_action_access("Disposition")


def has_quality_release_approval_access() -> bool:
	return has_terminal_action_access("Concession Approval")


def has_quality_gate_direct_override_access() -> bool:
	return _has_any_role(get_quality_gate_direct_override_roles())


def get_quality_gate_direct_override_roles() -> tuple[str, ...]:
	if not frappe.db.exists("DocType", "JCE Quality Settings"):
		return ()

	try:
		settings_meta = frappe.get_meta("JCE Quality Settings")
	except Exception:
		return ()

	if not settings_meta.has_field("quality_gate_override_roles"):
		return ()

	try:
		settings = frappe.get_single("JCE Quality Settings")
	except Exception:
		return ()

	roles = [row.role for row in (settings.get("quality_gate_override_roles") or []) if row.get("role")]
	return tuple(dict.fromkeys(roles))


def ensure_quality_gate_direct_override_role():
	if not frappe.db.exists("Role", QUALITY_GATE_DIRECT_OVERRIDE_ROLE):
		role_doc = frappe.new_doc("Role")
		role_doc.role_name = QUALITY_GATE_DIRECT_OVERRIDE_ROLE
		if frappe.get_meta("Role").has_field("desk_access"):
			role_doc.desk_access = 1
		role_doc.insert(ignore_permissions=True)

	if not frappe.db.exists("DocType", "JCE Quality Settings"):
		return

	try:
		settings_meta = frappe.get_meta("JCE Quality Settings")
	except Exception:
		return

	if not settings_meta.has_field("quality_gate_override_roles"):
		return

	settings = frappe.get_single("JCE Quality Settings")
	rows = settings.get("quality_gate_override_roles") or []
	if any(row.get("role") == QUALITY_GATE_DIRECT_OVERRIDE_ROLE for row in rows):
		return

	settings.append("quality_gate_override_roles", {"role": QUALITY_GATE_DIRECT_OVERRIDE_ROLE})
	settings.save(ignore_permissions=True)


def require_terminal_action_access(action: str):
	if has_terminal_action_access(action):
		return

	frappe.throw(_("Not permitted to perform this terminal action."), frappe.PermissionError)


def has_terminal_action_access(action: str) -> bool:
	return _has_any_role(get_terminal_action_roles(action))


def get_terminal_action_roles(action: str) -> tuple[str, ...]:
	default_roles = TERMINAL_ACTION_DEFAULT_ROLES.get(action) or QUALITY_DISPOSITION_ROLES
	if not frappe.db.exists("DocType", "JCE Quality Settings"):
		return tuple(default_roles)

	try:
		settings_meta = frappe.get_meta("JCE Quality Settings")
	except Exception:
		return tuple(default_roles)

	if not settings_meta.has_field("terminal_action_roles"):
		return tuple(default_roles)

	try:
		settings = frappe.get_single("JCE Quality Settings")
	except Exception:
		return tuple(default_roles)

	roles = [
		row.role
		for row in (settings.get("terminal_action_roles") or [])
		if row.get("action") == action and row.get("role")
	]
	return tuple(dict.fromkeys(roles)) or tuple(default_roles)


def require_dmr_stock_transfer_access():
	if frappe.session.user == "Administrator":
		return

	user_roles = set(frappe.get_roles())
	if "System Manager" in user_roles:
		return
	if "Quality Manager" in user_roles and user_roles.intersection(DMR_STOCK_ROLES):
		return

	frappe.throw(
		_("Only a Quality Manager with stock access can create DMR stock transfers."),
		frappe.PermissionError,
	)


def check_document_permission(doc, permtype: str):
	if frappe.session.user == "Administrator":
		return
	doc.check_permission(permtype)


def check_doctype_document_permission(doctype: str, name: str, permtype: str):
	doc = frappe.get_doc(doctype, name)
	check_document_permission(doc, permtype)
	return doc


def _require_any_role(allowed_roles: tuple[str, ...]):
	if _has_any_role(allowed_roles):
		return

	frappe.throw(_("Not permitted to access production quality data."), frappe.PermissionError)


def _has_any_role(allowed_roles: tuple[str, ...]) -> bool:
	if frappe.session.user == "Administrator":
		return True
	return bool(set(frappe.get_roles()).intersection(allowed_roles))
