from __future__ import annotations

import frappe


def ensure_quality_workflows():
	for state, style in {
		"Draft": "Danger",
		"Pending Manufacturing Review": "Info",
		"Pending Quality Approval": "Info",
		"Approved": "Success",
		"Suspended": "Warning",
		"Obsolete": "Danger",
		"In Review": "Info",
		"Pending Disposition": "Warning",
		"Pending Return Rejection": "Warning",
		"Return Rejection Completed": "Success",
		"Escalated": "Warning",
		"Closed": "Success",
		"Requested": "Info",
		"Rejected": "Danger",
		"Used": "Success",
		"Cancelled": "Danger",
	}.items():
		ensure_workflow_state(state, style)

	for action in (
		"Submit",
		"Manufacturing Review Complete",
		"Quality Approve",
		"Request Revision",
		"Escalate",
		"Review",
		"Request Return Rejection",
		"Complete Return Rejection",
		"Close",
		"Request Bypass",
		"Approve",
		"Reject",
		"Cancel",
	):
		ensure_workflow_action(action)

	ensure_workflow(
		"Quality Inspection Template Approval Workflow",
		"Quality Inspection Template",
		"status",
		[
			("Draft", 0, "Manufacturing Manager"),
			("Pending Manufacturing Review", 0, "Manufacturing Manager"),
			("Pending Quality Approval", 0, "Quality Manager"),
			("Approved", 0, "Quality Manager"),
			("Suspended", 0, "Quality Manager"),
			("Obsolete", 0, "Quality Manager"),
			("Cancelled", 0, "System Manager"),
		],
		[
			("Draft", "Submit", "Pending Manufacturing Review", "Manufacturing Manager"),
			(
				"Pending Manufacturing Review",
				"Manufacturing Review Complete",
				"Pending Quality Approval",
				"Manufacturing Manager",
			),
			("Pending Quality Approval", "Quality Approve", "Approved", "Quality Manager"),
			("Pending Manufacturing Review", "Request Revision", "Draft", "Manufacturing Manager"),
			("Pending Quality Approval", "Request Revision", "Draft", "Quality Manager"),
			("Draft", "Cancel", "Cancelled", "System Manager"),
		],
	)
	remove_obsolete_workflow("Quality Checklist Approval Workflow")

	ensure_workflow(
		"DMR Workflow",
		"DMR",
		"status",
		[
			("Draft", 0, "Quality Manager"),
			("In Review", 0, "Quality Manager"),
			("Pending Disposition", 0, "Quality Manager"),
			("Pending Return Rejection", 0, "Quality Manager"),
			("Return Rejection Completed", 0, "Quality Manager"),
			("Escalated", 0, "Quality Manager"),
			("Closed", 0, "Quality Manager"),
			("Cancelled", 0, "Quality Manager"),
		],
		[
			("Draft", "Submit", "In Review", "Quality Manager"),
			("In Review", "Escalate", "Escalated", "Quality Manager"),
			("In Review", "Review", "Pending Disposition", "Quality Manager"),
			("Escalated", "Review", "Pending Disposition", "Quality Manager"),
			("Pending Disposition", "Request Return Rejection", "Pending Return Rejection", "Quality Manager"),
			("Pending Return Rejection", "Complete Return Rejection", "Return Rejection Completed", "Quality Manager"),
			("Return Rejection Completed", "Review", "Pending Disposition", "Quality Manager"),
			("Pending Disposition", "Close", "Closed", "Quality Manager"),
			("Draft", "Cancel", "Cancelled", "Quality Manager"),
		],
	)

	ensure_workflow(
		"Quality Gate Bypass Workflow",
		"Quality Gate Bypass",
		"status",
		[
			("Draft", 0, "Stock User"),
			("Requested", 0, "Quality Manager"),
			("Approved", 0, "Quality Manager"),
			("Rejected", 0, "Quality Manager"),
			("Used", 0, "Quality Manager"),
			("Cancelled", 0, "Stock User"),
		],
		[
			("Draft", "Request Bypass", "Requested", "Stock User"),
			("Requested", "Approve", "Approved", "Quality Manager"),
			("Requested", "Reject", "Rejected", "Quality Manager"),
			("Draft", "Cancel", "Cancelled", "Stock User"),
		],
	)


def ensure_workflow_state(state: str, style: str):
	if frappe.db.exists("Workflow State", state):
		return
	frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": state, "style": style}).insert(
		ignore_permissions=True
	)


def ensure_workflow_action(action: str):
	if frappe.db.exists("Workflow Action Master", action):
		return
	frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": action}).insert(
		ignore_permissions=True
	)


def ensure_workflow(name: str, document_type: str, state_field: str, states: list[tuple], transitions: list[tuple]):
	if not frappe.db.exists("DocType", document_type):
		return
	doc = frappe.get_doc("Workflow", name) if frappe.db.exists("Workflow", name) else frappe.new_doc("Workflow")
	doc.workflow_name = name
	doc.document_type = document_type
	doc.is_active = 1
	doc.override_status = 0
	doc.send_email_alert = 0
	doc.workflow_state_field = state_field
	doc.set("states", [])
	for state, doc_status, allow_edit in states:
		row = doc.append("states", {})
		row.state = state
		row.doc_status = str(doc_status)
		row.allow_edit = allow_edit
		row.send_email = 0
	doc.set("transitions", [])
	for state, action, next_state, allowed in transitions:
		row = doc.append("transitions", {})
		row.state = state
		row.action = action
		row.next_state = next_state
		row.allowed = allowed
		row.allow_self_approval = 1
		row.send_email_to_creator = 0
	if doc.is_new():
		doc.insert(ignore_permissions=True)
	else:
		doc.save(ignore_permissions=True)


def remove_obsolete_workflow(name: str):
	if frappe.db.exists("Workflow", name):
		frappe.delete_doc("Workflow", name, ignore_permissions=True, force=True)
