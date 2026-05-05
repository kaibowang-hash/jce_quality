from __future__ import annotations

import frappe
from frappe import _


QUALITY_READ_ROLES = ("System Manager", "Quality Manager", "Quality User", "Manufacturing Manager", "Manufacturing User")
QUALITY_EXECUTION_ROLES = ("System Manager", "Quality Manager", "Quality User")
QUALITY_ANALYTICS_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager")
QUALITY_DISPOSITION_ROLES = ("System Manager", "Quality Manager")
QUALITY_GATE_DIRECT_OVERRIDE_ROLE = "JCE Quality Gate Override"
QUALITY_REPORT_ROLES = {
	"Production Quality Execution Summary": (
		"System Manager",
		"Quality Manager",
		"Quality User",
		"Manufacturing Manager",
		"Manufacturing User",
	),
}
READ_ONLY_PERMISSIONS = {
	"read": 1,
	"print": 1,
	"email": 1,
	"report": 1,
	"export": 1,
	"share": 1,
}
PERMISSION_FLAG_FIELDS = (
	"read",
	"write",
	"create",
	"submit",
	"cancel",
	"delete",
	"amend",
	"print",
	"email",
	"report",
	"export",
	"share",
	"import",
	"select",
)
QUALITY_MANAGER_STOCK_ENTRY_PERMISSIONS = {
	**READ_ONLY_PERMISSIONS,
	"create": 1,
	"write": 1,
	"submit": 1,
}
QUALITY_ROLE_DOCTYPE_PERMISSIONS = {
	"Delivery Note": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Delivery Plan": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Item": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Warehouse": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Work Order": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Work Order Scheduling": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Workstation": {
		"Quality Manager": READ_ONLY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
	"Stock Entry": {
		"Quality Manager": QUALITY_MANAGER_STOCK_ENTRY_PERMISSIONS,
		"Quality User": READ_ONLY_PERMISSIONS,
	},
}
TERMINAL_ACTION_DEFAULT_ROLES = {
	"Temporary Continue": ("System Manager", "Quality Manager", "Quality User"),
	"Disposition": ("System Manager", "Quality Manager"),
	"Concession Approval": ("System Manager", "Quality Manager"),
	"OQC Release": ("System Manager", "Quality Manager", "Quality User"),
	"OQC Temporary Release": ("System Manager", "Quality Manager"),
	"OQC Block": ("System Manager", "Quality Manager", "Quality User"),
	"OQC DMR Escalation": ("System Manager", "Quality Manager"),
	"OQC Email": ("System Manager", "Quality Manager", "Quality User", "Sales Manager", "Sales User"),
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


def ensure_quality_report_roles():
	for report_name, roles in QUALITY_REPORT_ROLES.items():
		if not frappe.db.exists("Report", report_name):
			continue

		report = frappe.get_doc("Report", report_name)
		existing_roles = {row.role for row in (report.get("roles") or []) if row.get("role")}
		changed = False
		for role in roles:
			if role in existing_roles:
				continue
			report.append("roles", {"role": role})
			changed = True
		if changed:
			report.save(ignore_permissions=True)


def ensure_quality_role_permissions():
	for doctype, role_permissions in QUALITY_ROLE_DOCTYPE_PERMISSIONS.items():
		if not frappe.db.exists("DocType", doctype):
			continue
		for role, permissions in role_permissions.items():
			if not frappe.db.exists("Role", role):
				continue
			ensure_doctype_role_permission(doctype, role, permissions)


def ensure_doctype_role_permission(doctype: str, role: str, permissions: dict):
	filters = {"parent": doctype, "parenttype": "DocType", "role": role, "permlevel": 0}
	if perm_name := frappe.db.exists("DocPerm", filters):
		perm = frappe.get_doc("DocPerm", perm_name)
	else:
		perm = frappe.new_doc("DocPerm")
		perm.parent = doctype
		perm.parenttype = "DocType"
		perm.parentfield = "permissions"
		perm.role = role
		perm.permlevel = 0

	changed = False
	for fieldname in PERMISSION_FLAG_FIELDS:
		value = 1 if permissions.get(fieldname) else 0
		if perm.get(fieldname) == value:
			continue
		perm.set(fieldname, value)
		changed = True

	if perm.is_new():
		perm.insert(ignore_permissions=True)
	elif changed:
		perm.save(ignore_permissions=True)


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
	if "Quality Manager" in user_roles:
		return

	frappe.throw(
		_("Only a Quality Manager can create DMR stock transfers."),
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
