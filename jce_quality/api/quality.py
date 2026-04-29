import frappe
from frappe import _
from frappe.utils import now_datetime

from jce_quality.services.quality import (
	approve_concession_release as approve_concession_release_doc,
	get_board_data,
	get_defect_code_options as get_defect_code_option_rows,
	get_quality_analytics_data as get_quality_analytics_data_rows,
	get_terminal_tasks,
	get_work_order_scheduling_summary,
	load_template_readings,
	make_quality_checks,
	mark_disposition,
	validate_quality_gate_for_scheduling,
)
from jce_quality.services.permissions import (
	require_quality_analytics_access,
	require_quality_disposition_access,
	require_quality_execution_access,
	require_quality_read_access,
)


@frappe.whitelist()
def generate_checks_for_scheduling(work_order_scheduling, scheduling_item=None, nodes=None):
	require_quality_execution_access()
	if isinstance(nodes, str):
		import json

		nodes = json.loads(nodes) if nodes.startswith("[") else [nodes]
	return make_quality_checks(work_order_scheduling, scheduling_item=scheduling_item, nodes=nodes)


@frappe.whitelist()
def get_scheduling_quality_summary(work_order_scheduling):
	require_quality_read_access()
	return get_work_order_scheduling_summary(work_order_scheduling)


@frappe.whitelist()
def get_terminal_task_list(posting_date=None, plant_floor=None, shift_type=None, work_order_scheduling=None):
	require_quality_read_access()
	return get_terminal_tasks(
		posting_date=posting_date,
		plant_floor=plant_floor,
		shift_type=shift_type,
		work_order_scheduling=work_order_scheduling,
	)


@frappe.whitelist()
def get_quality_board_data(posting_date=None, plant_floor=None, shift_type=None):
	require_quality_read_access()
	return get_board_data(posting_date=posting_date, plant_floor=plant_floor, shift_type=shift_type)


@frappe.whitelist()
def validate_scheduling_quality_gate(work_order_scheduling):
	require_quality_execution_access()
	validate_quality_gate_for_scheduling(work_order_scheduling)
	return True


@frappe.whitelist()
def get_or_create_check(work_order_scheduling, scheduling_item, quality_node):
	require_quality_execution_access()
	existing = frappe.get_all(
		"Production Quality Check",
		filters={
			"work_order_scheduling": work_order_scheduling,
			"scheduling_item": scheduling_item,
			"quality_node": quality_node,
			"docstatus": 0,
		},
		pluck="name",
		limit_page_length=1,
	)
	if existing:
		return get_check_payload(existing[0])

	created = make_quality_checks(work_order_scheduling, scheduling_item=scheduling_item, nodes=[quality_node])
	if not created:
		existing = frappe.get_all(
			"Production Quality Check",
			filters={
				"work_order_scheduling": work_order_scheduling,
				"scheduling_item": scheduling_item,
				"quality_node": quality_node,
				"docstatus": ("<", 2),
			},
			pluck="name",
			order_by="modified desc",
			limit_page_length=1,
		)
		if existing:
			return get_check_payload(existing[0])
		frappe.throw(_("No quality check was created. Please review Production Quality Rule."))

	return get_check_payload(created[0])


@frappe.whitelist()
def get_check_payload(check_name):
	require_quality_read_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	return doc.as_dict()


@frappe.whitelist()
def start_check(check_name):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	doc.start_inspection()
	return get_check_payload(check_name)


@frappe.whitelist()
def save_check(
	check_name,
	readings=None,
	sample_manager=None,
	manual_inspection=None,
	overall_status=None,
	remarks=None,
	inspection_photo=None,
	defects=None,
	defect_photos=None,
):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	if doc.docstatus:
		photos = _parse_json_list(defect_photos)
		if (
			(inspection_photo is not None or photos)
			and readings is None
			and sample_manager is None
			and manual_inspection is None
			and overall_status is None
			and remarks is None
			and defects is None
		):
			if inspection_photo is not None:
				doc.db_set("inspection_photo", inspection_photo, update_modified=False)
			if photos:
				_set_defect_photos(doc, photos, append=True)
				doc.flags.ignore_validate_update_after_submit = True
				doc.save(ignore_permissions=True)
			return get_check_payload(doc.name)
		frappe.throw(_("Submitted quality checks cannot be edited here."))

	if sample_manager is not None:
		doc.sample_manager = sample_manager
	if manual_inspection is not None:
		doc.manual_inspection = int(manual_inspection)
	if overall_status:
		doc.overall_status = overall_status
	if remarks is not None:
		doc.remarks = remarks
	if inspection_photo is not None:
		doc.inspection_photo = inspection_photo
	if defects is not None:
		_set_defects(doc, _parse_json_list(defects))
	if defect_photos is not None:
		_set_defect_photos(doc, _parse_json_list(defect_photos))

	if readings is not None:
		readings = _parse_json_list(readings)
		for incoming in readings:
			for row in doc.readings:
				if row.name == incoming.get("name") or row.idx == incoming.get("idx"):
					for fieldname in (
						"reading_value",
						"reading_1",
						"reading_2",
						"reading_3",
						"reading_4",
						"reading_5",
						"reading_6",
						"reading_7",
						"reading_8",
						"reading_9",
						"reading_10",
						"status",
					):
						if fieldname in incoming:
							row.set(fieldname, incoming.get(fieldname))
					break

	doc.save(ignore_permissions=True)
	return get_check_payload(doc.name)


@frappe.whitelist()
def submit_check(check_name, readings=None, **kwargs):
	require_quality_execution_access()
	if readings is not None or kwargs:
		save_check(check_name, readings=readings, **kwargs)
	doc = frappe.get_doc("Production Quality Check", check_name)
	doc.inspection_finished_at = doc.inspection_finished_at or now_datetime()
	doc.flags.ignore_permissions = True
	doc.submit()
	return get_check_payload(doc.name)


@frappe.whitelist()
def set_disposition(check_name, disposition, remarks=None):
	require_quality_disposition_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	mark_disposition(doc, disposition, remarks)
	return get_check_payload(check_name)


@frappe.whitelist()
def approve_concession_release(check_name):
	require_quality_disposition_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	approve_concession_release_doc(doc)
	return get_check_payload(check_name)


@frappe.whitelist()
def reload_template_readings(check_name, template=None):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	if doc.docstatus:
		frappe.throw(_("Submitted quality checks cannot reload template readings."))
	if template:
		doc.quality_inspection_template = template
	load_template_readings(doc, force=True)
	doc.save(ignore_permissions=True)
	return get_check_payload(doc.name)


@frappe.whitelist()
def get_defect_code_options(txt=None):
	require_quality_read_access()
	return get_defect_code_option_rows(txt)


@frappe.whitelist()
def get_quality_analytics_data(filters=None):
	require_quality_analytics_access()
	return get_quality_analytics_data_rows(filters)


def _parse_json_list(value):
	if value is None:
		return []
	if isinstance(value, str):
		import json

		return json.loads(value) if value else []
	return value


def _set_defects(doc, defects):
	doc.set("defects", [])
	for incoming in defects or []:
		if not incoming.get("defect_code"):
			continue
		row = doc.append("defects", {})
		for fieldname in ("defect_code", "quantity", "remarks"):
			if fieldname in incoming:
				row.set(fieldname, incoming.get(fieldname))


def _set_defect_photos(doc, photos, append=False):
	existing = {(row.image, row.caption or "") for row in doc.get("defect_photos", [])}
	if not append:
		doc.set("defect_photos", [])
	for incoming in photos or []:
		image = incoming.get("image") or incoming.get("file_url")
		if not image:
			continue
		caption = incoming.get("caption") or ""
		if append and (image, caption) in existing:
			continue
		row = doc.append("defect_photos", {})
		row.image = image
		row.caption = caption
