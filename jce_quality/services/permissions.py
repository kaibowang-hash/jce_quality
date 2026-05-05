from __future__ import annotations

import frappe
from frappe import _


QUALITY_READ_ROLES = ("System Manager", "Quality Manager", "Quality User", "Manufacturing Manager", "Manufacturing User")
QUALITY_EXECUTION_ROLES = ("System Manager", "Quality Manager", "Quality User")
QUALITY_ANALYTICS_ROLES = ("System Manager", "Quality Manager", "Manufacturing Manager")
QUALITY_DISPOSITION_ROLES = ("System Manager", "Quality Manager")
DMR_STOCK_ROLES = ("Stock Manager", "Stock User")


def require_quality_read_access():
	_require_any_role(QUALITY_READ_ROLES)


def require_quality_execution_access():
	_require_any_role(QUALITY_EXECUTION_ROLES)


def require_quality_analytics_access():
	_require_any_role(QUALITY_ANALYTICS_ROLES)


def require_quality_disposition_access():
	_require_any_role(QUALITY_DISPOSITION_ROLES)


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
	if frappe.session.user == "Administrator":
		return

	user_roles = set(frappe.get_roles())
	if user_roles.intersection(allowed_roles):
		return

	frappe.throw(_("Not permitted to access production quality data."), frappe.PermissionError)
