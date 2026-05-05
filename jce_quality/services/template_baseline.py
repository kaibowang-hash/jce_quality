from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.utils import cint, now_datetime, nowdate


ACTIVE_TEMPLATE_STATUSES = ("Approved", "Suspended")
OBSOLETE_TEMPLATE_STATUSES = ("Obsolete", "Cancelled")


def get_current_item_af(item_code: str | None) -> str | None:
	if not item_code or not frappe.db.exists("Item", item_code):
		return None
	if not frappe.get_meta("Item").has_field("custom_af_reference"):
		return None
	return frappe.db.get_value("Item", item_code, "custom_af_reference")


def get_item_drawing(item_code: str | None) -> str | None:
	if not item_code or not frappe.db.exists("Item", item_code):
		return None
	if not frappe.get_meta("Item").has_field("drawing_file"):
		return None
	return frappe.db.get_value("Item", item_code, "drawing_file")


def get_item_template_link(item_code: str | None) -> str | None:
	if not item_code or not frappe.db.exists("Item", item_code):
		return None
	meta = frappe.get_meta("Item")
	if meta.has_field("custom_current_quality_inspection_template"):
		return frappe.db.get_value("Item", item_code, "custom_current_quality_inspection_template")
	return None


def get_active_template(item_code: str | None):
	if not item_code:
		return None
	linked_template = get_item_template_link(item_code)
	if linked_template and frappe.db.exists("Quality Inspection Template", linked_template):
		doc = frappe.get_doc("Quality Inspection Template", linked_template)
		if cint(doc.get("current_effective")) and doc.get("status") in ACTIVE_TEMPLATE_STATUSES:
			return doc
	name = frappe.db.get_value(
		"Quality Inspection Template",
		{
			"item_code": item_code,
			"status": ("in", ACTIVE_TEMPLATE_STATUSES),
			"current_effective": 1,
		},
		"name",
		order_by="modified desc",
	)
	return frappe.get_doc("Quality Inspection Template", name) if name else None


def apply_template_to_check(doc):
	item_code = getattr(doc, "item_code", None)
	template = get_active_template(item_code)
	if not template and getattr(doc, "quality_inspection_template", None) and frappe.db.exists(
		"Quality Inspection Template", doc.quality_inspection_template
	):
		template = frappe.get_doc("Quality Inspection Template", doc.quality_inspection_template)
	current_af = get_current_item_af(item_code)
	item_drawing = get_item_drawing(item_code)
	if not template:
		doc.template_version = None
		doc.template_af_reference = current_af
		doc.drawing_file = item_drawing
		doc.template_warning = None
		return

	doc.quality_inspection_template = template.name
	doc.template_version = template.get("version")
	doc.template_af_reference = template.get("af_reference")
	doc.drawing_file = item_drawing if doc.get("quality_node") == "Last Article" else (template.get("drawing_file") or item_drawing)

	if template.get("status") == "Suspended" or (current_af and current_af != template.get("af_reference")):
		doc.template_warning = _(
			"Quality Inspection Template {0} is not aligned with the current Item AF. Template AF: {1}; Item AF: {2}."
		).format(template.name, template.get("af_reference") or "-", current_af or "-")
	else:
		doc.template_warning = None


def handle_item_af_change(doc, method=None):
	if not doc.name or not getattr(doc, "has_value_changed", None):
		return
	if not doc.has_value_changed("custom_af_reference"):
		return
	template = get_active_template(doc.name)
	if not template or template.get("af_reference") == doc.get("custom_af_reference"):
		return
	suspend_template_for_af_change(template.name, doc.get("custom_af_reference"))


def before_insert_template(doc, method=None):
	populate_template_from_item(doc)
	if doc.get("item_code"):
		doc.version = normalize_version(doc.get("version") or get_next_version(doc.item_code))
		doc.naming_dd = current_naming_period()
		doc.quality_inspection_template_name = make_template_name(doc.item_code, doc.naming_dd, doc.version)


def validate_template(doc, method=None):
	doc.status = doc.get("status") or "Draft"
	if doc.get("item_code"):
		populate_template_from_item(doc)
		doc.version = normalize_version(doc.get("version") or "A")
		doc.updated_to_version = doc.version
		if doc.get("update_source") and not doc.get("updated_from_version"):
			doc.updated_from_version = frappe.db.get_value("Quality Inspection Template", doc.update_source, "version")
	validate_active_template(doc)


def on_update_template(doc, method=None):
	if doc.get("status") == "Approved":
		activate_template(doc)


def populate_template_from_item(doc):
	if not doc.get("item_code") or not frappe.db.exists("Item", doc.item_code):
		return
	fields = ["item_name"]
	item_meta = frappe.get_meta("Item")
	for fieldname in ("custom_af_reference", "drawing_file"):
		if item_meta.has_field(fieldname):
			fields.append(fieldname)
	item = frappe.db.get_value("Item", doc.item_code, fields, as_dict=True)
	if not item:
		return
	doc.item_name = item.item_name
	doc.af_reference = doc.get("af_reference") or item.get("custom_af_reference")
	doc.drawing_file = doc.get("drawing_file") or item.get("drawing_file")


def validate_active_template(doc):
	will_be_effective = doc.get("status") in ACTIVE_TEMPLATE_STATUSES or cint(doc.get("current_effective"))
	if not will_be_effective:
		return
	for fieldname, label in {
		"item_code": _("Item"),
		"af_reference": _("AF Reference"),
		"naming_dd": _("YYMM"),
	}.items():
		if not doc.get(fieldname):
			frappe.throw(_("{0} is required for an effective Quality Inspection Template.").format(label))
	excluded_names = [doc.name]
	if doc.get("update_source"):
		excluded_names.append(doc.update_source)
	if frappe.db.exists(
		"Quality Inspection Template",
		{
			"name": ("not in", excluded_names),
			"status": ("in", ACTIVE_TEMPLATE_STATUSES),
			"current_effective": 1,
			"item_code": doc.item_code,
		},
	):
		frappe.throw(_("Item {0} already has an effective Quality Inspection Template.").format(doc.item_code))
	if frappe.db.exists(
		"Quality Inspection Template",
		{
			"name": ("not in", excluded_names),
			"status": ("in", ACTIVE_TEMPLATE_STATUSES),
			"current_effective": 1,
			"af_reference": doc.af_reference,
		},
	):
		frappe.throw(_("AF Reference {0} already has an effective Quality Inspection Template.").format(doc.af_reference))


def activate_template(doc):
	if not cint(doc.get("current_effective")):
		doc.db_set("current_effective", 1, update_modified=False)
	old_templates = frappe.get_all(
		"Quality Inspection Template",
		filters={"name": ("!=", doc.name), "item_code": doc.item_code, "current_effective": 1},
		pluck="name",
	)
	if doc.get("update_source") and doc.update_source not in old_templates:
		old_templates.append(doc.update_source)
	for template_name in set(filter(None, old_templates)):
		frappe.db.set_value(
			"Quality Inspection Template",
			template_name,
			{"status": "Obsolete", "current_effective": 0},
			update_modified=True,
		)
	if frappe.get_meta("Item").has_field("custom_current_quality_inspection_template"):
		frappe.db.set_value(
			"Item",
			doc.item_code,
			"custom_current_quality_inspection_template",
			doc.name,
			update_modified=False,
		)


def suspend_template_for_af_change(template_name: str, new_af_reference: str | None = None):
	template = frappe.get_doc("Quality Inspection Template", template_name)
	if template.get("status") == "Suspended":
		return template.name
	reason = _("Item AF changed from {0} to {1}. Template version update is required.").format(
		template.get("af_reference") or "-", new_af_reference or "-"
	)
	template.db_set(
		{
			"status": "Suspended",
			"suspended_at": now_datetime(),
			"suspended_by": frappe.session.user if frappe.session.user != "Guest" else "Administrator",
			"suspend_reason": reason,
		},
		update_modified=True,
	)
	notify_template_suspension(template.name, reason)
	return template.name


def notify_template_suspension(template_name: str, reason: str):
	role = frappe.db.get_single_value("JCE Quality Settings", "default_template_suspension_role") or "Quality Manager"
	users = frappe.get_all(
		"Has Role",
		filters={"role": role, "parenttype": "User"},
		pluck="parent",
		limit_page_length=500,
	)
	for user in users:
		if not frappe.db.get_value("User", user, "enabled"):
			continue
		if frappe.db.exists(
			"ToDo",
			{
				"allocated_to": user,
				"reference_type": "Quality Inspection Template",
				"reference_name": template_name,
				"status": "Open",
			},
		):
			continue
		frappe.get_doc(
			{
				"doctype": "ToDo",
				"allocated_to": user,
				"reference_type": "Quality Inspection Template",
				"reference_name": template_name,
				"description": reason,
				"priority": "High",
				"status": "Open",
				"assigned_by": frappe.session.user if frappe.session.user != "Guest" else "Administrator",
			}
		).insert(ignore_permissions=True)


def create_next_template_version(template_name: str, update_reason: str) -> str:
	if not update_reason:
		frappe.throw(_("Update Reason is required."))
	source = frappe.get_doc("Quality Inspection Template", template_name)
	current_af = get_current_item_af(source.get("item_code"))
	if not source.get("item_code"):
		frappe.throw(_("Item is required before creating a new template version."))
	if not current_af:
		frappe.throw(_("Item {0} does not have a current AF Reference.").format(source.item_code))

	new_version = next_version(source.get("version"))
	naming_period = current_naming_period()
	new_doc = frappe.copy_doc(source)
	new_doc.name = None
	new_doc.naming_dd = naming_period
	new_doc.quality_inspection_template_name = make_template_name(source.item_code, naming_period, new_version)
	new_doc.af_reference = current_af
	new_doc.version = new_version
	new_doc.status = "Draft"
	new_doc.current_effective = 0
	new_doc.update_source = source.name
	new_doc.update_reason = update_reason
	new_doc.updated_from_version = source.get("version")
	new_doc.updated_to_version = new_version
	new_doc.set("version_logs", [])
	for source_log in source.get("version_logs", []):
		row = new_doc.append("version_logs", {})
		for fieldname in (
			"update_date",
			"from_version",
			"to_version",
			"update_reason",
			"updated_by",
			"source_template",
			"new_template",
		):
			row.set(fieldname, source_log.get(fieldname))
	log = new_doc.append("version_logs", {})
	log.update(
		{
			"update_date": now_datetime(),
			"from_version": source.get("version"),
			"to_version": new_version,
			"update_reason": update_reason,
			"updated_by": frappe.session.user,
			"source_template": source.name,
		}
	)
	new_doc.insert(ignore_permissions=True)
	log.db_set("new_template", new_doc.name, update_modified=False)
	return new_doc.name


def get_template_payload(template_name: str | None):
	if not template_name or not frappe.db.exists("Quality Inspection Template", template_name):
		return None
	doc = frappe.get_doc("Quality Inspection Template", template_name)
	return {
		"name": doc.name,
		"status": doc.get("status"),
		"version": doc.get("version"),
		"af_reference": doc.get("af_reference"),
		"drawing_file": doc.get("drawing_file"),
	}


def migrate_quality_checklist_data():
	if not frappe.db.exists("DocType", "Quality Checklist"):
		return
	checklists = frappe.get_all(
		"Quality Checklist",
		fields=[
			"name",
			"item_code",
			"item_name",
			"version",
			"naming_dd",
			"status",
			"current_effective",
			"af_reference",
			"drawing_file",
			"quality_inspection_template",
			"suspended_at",
			"suspended_by",
			"suspend_reason",
		],
		limit_page_length=0,
	)
	for checklist in checklists:
		target = get_or_create_template_for_checklist(checklist)
		if not target:
			continue
		status = map_checklist_status(checklist.status)
		frappe.db.set_value(
			"Quality Inspection Template",
			target,
			{
				"item_code": checklist.item_code,
				"item_name": checklist.item_name,
				"version": checklist.version,
				"naming_dd": checklist.naming_dd,
				"status": status,
				"current_effective": cint(checklist.current_effective) if status in ACTIVE_TEMPLATE_STATUSES else 0,
				"af_reference": checklist.af_reference,
				"drawing_file": checklist.drawing_file,
				"suspended_at": checklist.suspended_at,
				"suspended_by": checklist.suspended_by,
				"suspend_reason": checklist.suspend_reason,
			},
			update_modified=False,
		)
		if cint(checklist.current_effective) and status in ACTIVE_TEMPLATE_STATUSES:
			frappe.db.set_value(
				"Item",
				checklist.item_code,
				"custom_current_quality_inspection_template",
				target,
				update_modified=False,
			)


def get_or_create_template_for_checklist(checklist) -> str | None:
	if checklist.quality_inspection_template and frappe.db.exists(
		"Quality Inspection Template", checklist.quality_inspection_template
	):
		return checklist.quality_inspection_template
	if not checklist.item_code:
		return None
	name = make_template_name(checklist.item_code, checklist.naming_dd or current_naming_period(), checklist.version or "A")
	if frappe.db.exists("Quality Inspection Template", name):
		return name
	doc = frappe.new_doc("Quality Inspection Template")
	doc.quality_inspection_template_name = name
	doc.item_code = checklist.item_code
	doc.item_name = checklist.item_name
	doc.version = checklist.version or "A"
	doc.naming_dd = checklist.naming_dd or current_naming_period()
	doc.af_reference = checklist.af_reference
	doc.drawing_file = checklist.drawing_file
	doc.status = map_checklist_status(checklist.status)
	doc.current_effective = cint(checklist.current_effective) if doc.status in ACTIVE_TEMPLATE_STATUSES else 0
	doc.insert(ignore_permissions=True)
	return doc.name


def map_checklist_status(status: str | None) -> str:
	if status in ("Approved", "Suspended", "Obsolete", "Cancelled"):
		return status
	if status in ("Pending Manufacturing Review", "Pending Quality Approval"):
		return status
	return "Draft"


def get_next_version(item_code: str) -> str:
	current = frappe.db.get_value(
		"Quality Inspection Template",
		{"item_code": item_code},
		"version",
		order_by="creation desc",
	)
	if not current:
		return "A"
	return next_version(current)


def next_version(version: str | None) -> str:
	version = normalize_version(version)
	if not re.fullmatch(r"[A-Z]+", version):
		return "A"
	letters = list(version)
	index = len(letters) - 1
	while index >= 0:
		if letters[index] != "Z":
			letters[index] = chr(ord(letters[index]) + 1)
			return "".join(letters)
		letters[index] = "A"
		index -= 1
	return "A" + "".join(letters)


def normalize_version(version: str | None) -> str:
	return (version or "A").strip().upper()


def make_template_name(item_code: str | None, naming_dd: str | None, version: str | None) -> str:
	item = sanitize_name_segment(item_code)
	dd = sanitize_name_segment(naming_dd)
	if not item or not dd:
		frappe.throw(_("Item and YYMM are required for Quality Inspection Template naming."))
	return f"CL0{item}{dd}{normalize_version(version)}"


def current_naming_period() -> str:
	return nowdate().replace("-", "")[2:6]


def sanitize_name_segment(value: str | None) -> str:
	value = re.sub(r"\s+", "", value or "")
	value = value.replace("/", "-")
	value = re.sub(r"[^A-Za-z0-9._-]", "-", value)
	return value
