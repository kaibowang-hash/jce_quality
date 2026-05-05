import frappe
from frappe import _
from frappe.utils import now_datetime

from jce_quality.services.quality import (
	approve_concession_release as approve_concession_release_doc,
	create_manual_production_check as create_manual_production_check_doc,
	get_board_data,
	get_defect_code_options as get_defect_code_option_rows,
	get_delivery_plan_delivery_notes as get_delivery_plan_delivery_note_rows,
	get_delivery_oqc_items as get_delivery_oqc_item_rows,
	get_manual_production_quality_node_options as get_manual_production_quality_node_option_rows,
	get_oqc_email_package as get_oqc_email_package_doc,
	get_or_create_delivery_oqc_check as get_or_create_delivery_oqc_check_doc,
	get_quality_analytics_data as get_quality_analytics_data_rows,
	get_scheduling_quality_node_requirement,
	get_terminal_tasks,
	get_work_order_scheduling_summary,
	inspect_and_set_status,
	load_template_readings,
	make_quality_checks,
	mark_disposition,
	prepare_check_for_terminal,
	get_template_sample_plan,
	get_rule_max_defect_rate,
	validate_quality_gate_for_scheduling,
	is_production_blocking_ng,
	get_patrol_history_context,
	enqueue_oqc_pdf_cache,
	release_oqc_check as release_oqc_check_doc,
)
from jce_quality.services.dmr import confirm_ipqc_defect as confirm_ipqc_defect_doc
from jce_quality.services.template_baseline import get_template_payload
from jce_quality.services.permissions import (
	check_document_permission,
	check_doctype_document_permission,
	has_quality_disposition_access,
	has_quality_release_approval_access,
	has_terminal_action_access,
	require_quality_analytics_access,
	require_quality_disposition_access,
	require_quality_execution_access,
	require_quality_read_access,
	require_terminal_action_access,
)


@frappe.whitelist(methods=["POST"])
def generate_checks_for_scheduling(work_order_scheduling, scheduling_item=None, nodes=None):
	require_quality_execution_access()
	check_doctype_document_permission("Work Order Scheduling", work_order_scheduling, "read")
	if isinstance(nodes, str):
		import json

		nodes = json.loads(nodes) if nodes.startswith("[") else [nodes]
	return make_quality_checks(work_order_scheduling, scheduling_item=scheduling_item, nodes=nodes)


@frappe.whitelist()
def get_scheduling_quality_summary(work_order_scheduling):
	require_quality_read_access()
	check_doctype_document_permission("Work Order Scheduling", work_order_scheduling, "read")
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


@frappe.whitelist(methods=["POST"])
def validate_scheduling_quality_gate(work_order_scheduling):
	require_quality_execution_access()
	check_doctype_document_permission("Work Order Scheduling", work_order_scheduling, "read")
	validate_quality_gate_for_scheduling(work_order_scheduling)
	return True


@frappe.whitelist(methods=["POST"])
def get_or_create_check(work_order_scheduling, scheduling_item, quality_node):
	require_quality_execution_access()
	check_doctype_document_permission("Work Order Scheduling", work_order_scheduling, "read")
	requirement = get_scheduling_quality_node_requirement(work_order_scheduling, scheduling_item, quality_node)
	if not requirement.get("is_required"):
		frappe.throw(_("{0} is not required for this scheduling item.").format(_(quality_node)))
	rejected = frappe.get_all(
		"Production Quality Check",
		filters={
			"work_order_scheduling": work_order_scheduling,
			"scheduling_item": scheduling_item,
			"quality_node": quality_node,
			"docstatus": 1,
			"overall_status": "Rejected",
		},
		fields=["name", "docstatus", "overall_status", "disposition"],
		order_by="modified desc",
	)
	for check in rejected:
		if is_production_blocking_ng(check):
			return get_check_payload(check.name)

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

	created = make_quality_checks(
		work_order_scheduling,
		scheduling_item=scheduling_item,
		nodes=[quality_node],
		limit_per_node=1,
	)
	if not created:
		existing = frappe.get_all(
			"Production Quality Check",
			filters={
				"work_order_scheduling": work_order_scheduling,
				"scheduling_item": scheduling_item,
				"quality_node": quality_node,
				"docstatus": ("<", 2),
				"overall_status": ("!=", "Rejected"),
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
def get_manual_production_quality_node_options(item_code=None, workstation=None, company=None, plant_floor=None):
	require_quality_read_access()
	if item_code:
		check_doctype_document_permission("Item", item_code, "read")
	if workstation:
		check_doctype_document_permission("Workstation", workstation, "read")
	return get_manual_production_quality_node_option_rows(
		item_code=item_code,
		workstation=workstation,
		company=company,
		plant_floor=plant_floor,
	)


@frappe.whitelist(methods=["POST"])
def create_manual_production_check(
	item_code,
	workstation,
	quality_node="Patrol",
	company=None,
	plant_floor=None,
	shift_type=None,
	posting_date=None,
	qty=None,
	remarks=None,
):
	require_quality_execution_access()
	check_name = create_manual_production_check_doc(
		item_code=item_code,
		workstation=workstation,
		quality_node=quality_node,
		company=company,
		plant_floor=plant_floor,
		shift_type=shift_type,
		posting_date=posting_date,
		qty=qty,
		remarks=remarks,
	)
	return get_check_payload(check_name)


@frappe.whitelist()
def get_delivery_oqc_items(delivery_note):
	require_quality_read_access()
	check_doctype_document_permission("Delivery Note", delivery_note, "read")
	return get_delivery_oqc_item_rows(delivery_note)


@frappe.whitelist()
def get_delivery_plan_delivery_notes(delivery_plan):
	require_quality_read_access()
	if not frappe.db.exists("DocType", "Delivery Plan"):
		frappe.throw(_("Delivery Plan is not available on this site."))
	check_doctype_document_permission("Delivery Plan", delivery_plan, "read")
	return get_delivery_plan_delivery_note_rows(delivery_plan)


@frappe.whitelist(methods=["POST"])
def get_or_create_delivery_oqc_check(delivery_note, item_code, warehouse=None, uom=None):
	require_quality_execution_access()
	check_doctype_document_permission("Delivery Note", delivery_note, "read")
	check_name = get_or_create_delivery_oqc_check_doc(delivery_note, item_code, warehouse=warehouse, uom=uom)
	return get_check_payload(check_name)


@frappe.whitelist(methods=["POST"])
def release_oqc_check(check_name, release_status="Released", temporary_release_note=None, escalate_to_dmr=0):
	action = get_oqc_release_action(release_status, bool(int(escalate_to_dmr or 0)))
	require_terminal_action_access(action)
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	result = release_oqc_check_doc(
		check_name,
		release_status=release_status,
		temporary_release_note=temporary_release_note,
		escalate_to_dmr=bool(int(escalate_to_dmr or 0)),
	)
	return result


@frappe.whitelist()
def get_oqc_email_package(delivery_note, include_print_urls=1):
	require_oqc_email_access()
	check_doctype_document_permission("Delivery Note", delivery_note, "read")
	return get_oqc_email_package_doc(
		delivery_note,
		include_print_urls=bool(int(include_print_urls or 0)),
		ignore_check_permissions=has_terminal_action_access("OQC Email"),
	)


@frappe.whitelist(methods=["POST"])
def queue_oqc_pdf_cache(delivery_note):
	require_oqc_email_access()
	check_doctype_document_permission("Delivery Note", delivery_note, "read")
	job = enqueue_oqc_pdf_cache(delivery_note, ignore_check_permissions=has_terminal_action_access("OQC Email"))
	return {"delivery_note": delivery_note, "job_id": getattr(job, "id", None) or str(job)}


@frappe.whitelist()
def get_check_payload(check_name):
	require_quality_read_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "read")
	prepare_check_for_terminal(doc, persist=not doc.docstatus and doc.has_permission("write"))
	payload = doc.as_dict()
	payload["template_baseline"] = get_template_payload(doc.get("quality_inspection_template"))
	payload["sample_plan"] = get_template_sample_plan(doc.get("quality_inspection_template"), doc.get("quality_node"))
	payload["max_defect_rate"] = get_rule_max_defect_rate(doc)
	if doc.get("item_code"):
		payload["customer_code"] = get_item_customer_code(doc.item_code)
	payload.update(get_scheduling_alert_payload(doc.get("scheduling_item")))
	payload["patrol_increase_blocked"] = bool(payload.get("extra_patrol_source_check") == doc.name)
	payload["defect_summary"] = build_defect_summary(doc)
	payload["related_defect_alerts"] = get_related_defect_alerts(doc)
	if doc.get("quality_node") == "Patrol":
		payload.update(build_patrol_history_payload(doc))
	payload["terminal_permissions"] = {
		"can_temporary_continue": has_terminal_action_access("Temporary Continue") or has_quality_disposition_access(),
		"can_disposition": has_quality_disposition_access(),
		"can_approve_concession": has_quality_release_approval_access(),
		"can_oqc_release": has_terminal_action_access("OQC Release"),
		"can_oqc_temporary_release": has_terminal_action_access("OQC Temporary Release"),
		"can_oqc_block": has_terminal_action_access("OQC Block"),
		"can_oqc_escalate_to_dmr": has_terminal_action_access("OQC DMR Escalation"),
		"can_oqc_email": has_terminal_action_access("OQC Email"),
	}
	return payload


def get_oqc_release_action(release_status: str, escalate_to_dmr: bool = False) -> str:
	if escalate_to_dmr:
		return "OQC DMR Escalation"
	if release_status == "Temporary Released":
		return "OQC Temporary Release"
	if release_status == "Blocked":
		return "OQC Block"
	return "OQC Release"


def require_oqc_email_access():
	if has_terminal_action_access("OQC Email"):
		return
	require_quality_read_access()


@frappe.whitelist(methods=["POST"])
def start_check(check_name):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	doc.start_inspection()
	return get_check_payload(check_name)


@frappe.whitelist(methods=["POST"])
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
	inspection_stage=None,
	inspection_sample_qty=None,
	sample_readings=None,
):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	if doc.docstatus:
		photos = _parse_json_list(defect_photos)
		if (
			(inspection_photo is not None or photos or remarks is not None)
			and readings is None
			and sample_manager is None
			and manual_inspection is None
			and overall_status is None
			and defects is None
			and inspection_stage is None
			and inspection_sample_qty is None
			and sample_readings is None
		):
			if remarks is not None:
				doc.db_set("remarks", remarks, update_modified=not (inspection_photo is not None or photos))
			if inspection_photo is not None:
				doc.db_set("inspection_photo", inspection_photo, update_modified=False)
			if photos:
				_set_defect_photos(doc, photos, append=True)
				doc.flags.ignore_validate_update_after_submit = True
				doc.save(ignore_permissions=True)
			return get_check_payload(doc.name)
		frappe.throw(_("Submitted quality checks cannot be edited here."))

	prepare_check_for_terminal(doc)
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
	if inspection_stage is not None and doc.meta.has_field("inspection_stage"):
		doc.inspection_stage = inspection_stage
	if inspection_sample_qty is not None and doc.meta.has_field("inspection_sample_qty"):
		doc.inspection_sample_qty = max(int(inspection_sample_qty or 1), 1)
	if sample_readings is not None and doc.meta.has_field("sample_readings"):
		_set_sample_readings(doc, _parse_json_list(sample_readings))

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

	inspect_and_set_status(doc, require_values=False)
	doc.save(ignore_permissions=True)
	return get_check_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def submit_check(check_name, readings=None, **kwargs):
	require_quality_execution_access()
	kwargs = clean_save_kwargs(kwargs)
	if readings is not None or kwargs:
		save_check(check_name, readings=readings, **kwargs)
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "submit")
	prepare_check_for_terminal(doc)
	doc.inspection_finished_at = doc.inspection_finished_at or now_datetime()
	doc.flags.ignore_permissions = True
	doc.submit()
	return get_check_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def set_disposition(check_name, disposition, remarks=None):
	action = "Temporary Continue" if disposition == "Temporary Continue" else "Disposition"
	if action == "Temporary Continue":
		if not (has_terminal_action_access("Temporary Continue") or has_quality_disposition_access()):
			require_terminal_action_access("Temporary Continue")
	else:
		require_terminal_action_access(action)
	doc = frappe.get_doc("Production Quality Check", check_name)
	if action == "Temporary Continue" and doc.get("disposition") and doc.get("disposition") != "Temporary Continue":
		require_terminal_action_access("Disposition")
	check_document_permission(doc, "write")
	mark_disposition(doc, disposition, remarks)
	return get_check_payload(check_name)


@frappe.whitelist(methods=["POST"])
def approve_concession_release(check_name):
	require_terminal_action_access("Concession Approval")
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	approve_concession_release_doc(doc)
	return get_check_payload(check_name)


@frappe.whitelist(methods=["POST"])
def confirm_ipqc_defect(check_name, remarks=None, create_dmr=0):
	require_quality_disposition_access()
	return confirm_ipqc_defect_doc(check_name, remarks=remarks, create_dmr=bool(int(create_dmr)))


@frappe.whitelist(methods=["POST"])
def trigger_defect_alert(check_name, alert_note=None):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	note = alert_note or build_defect_summary(doc) or doc.remarks or _("Patrol NG found on {0}.").format(doc.name)
	update_scheduling_quality_alert(doc, alert_note=note)
	return {
		"check_name": doc.name,
		"alert_note": note,
		"notification_payload": {
			"event": "production_quality_defect_alert",
			"source_doctype": "Production Quality Check",
			"source_name": doc.name,
			"item_code": doc.item_code,
			"quality_node": doc.quality_node,
			"work_order_scheduling": doc.work_order_scheduling,
			"scheduling_item": doc.scheduling_item,
		},
	}


@frappe.whitelist(methods=["POST"])
def increase_patrol_count(check_name, increment=1, remarks=None):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
	row_name = doc.scheduling_item
	if not row_name or not frappe.db.exists("Scheduling Item", row_name):
		frappe.throw(_("Scheduling Item Row is required."))
	meta = frappe.get_meta("Scheduling Item")
	if not meta.has_field("jce_quality_extra_patrol_count"):
		frappe.throw(_("Please run migration to enable Extra Patrol Count."))
	if meta.has_field("jce_quality_extra_patrol_source_check"):
		source_check = frappe.db.get_value("Scheduling Item", row_name, "jce_quality_extra_patrol_source_check")
		if source_check == doc.name:
			frappe.throw(_("This inspection has already increased patrol frequency."))
	current = frappe.db.get_value("Scheduling Item", row_name, "jce_quality_extra_patrol_count") or 0
	values = {"jce_quality_extra_patrol_count": max(int(current) + int(increment or 1), 0)}
	if remarks:
		values["jce_quality_alert_note"] = remarks
	if meta.has_field("jce_quality_alert_open"):
		values["jce_quality_alert_open"] = 1
	if meta.has_field("jce_quality_alert_source_check"):
		values["jce_quality_alert_source_check"] = doc.name
	if meta.has_field("jce_quality_extra_patrol_source_check"):
		values["jce_quality_extra_patrol_source_check"] = doc.name
	frappe.db.set_value("Scheduling Item", row_name, values, update_modified=True)
	return get_check_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def reload_template_readings(check_name, template=None):
	require_quality_execution_access()
	doc = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(doc, "write")
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


def clean_save_kwargs(kwargs: dict | None) -> dict:
	allowed = {
		"sample_manager",
		"manual_inspection",
		"overall_status",
		"remarks",
		"inspection_photo",
		"defects",
		"defect_photos",
		"inspection_stage",
		"inspection_sample_qty",
		"sample_readings",
	}
	return {key: value for key, value in (kwargs or {}).items() if key in allowed}


def get_scheduling_alert_payload(scheduling_item: str | None) -> dict:
	if not scheduling_item or not frappe.db.exists("Scheduling Item", scheduling_item):
		return {}
	meta = frappe.get_meta("Scheduling Item")
	fields = {}
	for source, target in {
		"jce_quality_alert_open": "scheduling_alert_open",
		"jce_quality_alert_source_check": "scheduling_alert_source_check",
		"jce_quality_alert_note": "scheduling_alert_note",
		"jce_quality_extra_patrol_count": "extra_patrol_count",
		"jce_quality_extra_patrol_source_check": "extra_patrol_source_check",
	}.items():
		if meta.has_field(source):
			fields[target] = frappe.db.get_value("Scheduling Item", scheduling_item, source)
	return fields


def build_patrol_history_payload(doc) -> dict:
	context = get_patrol_history_context(doc)
	history = []
	for row in context.get("patrol_history") or []:
		item = dict(row)
		try:
			history_doc = frappe.get_doc("Production Quality Check", row.name)
			if not history_doc.has_permission("read"):
				continue
			item["defect_summary"] = build_defect_summary(history_doc)
		except Exception:
			item["defect_summary"] = ""
		history.append(item)
	return {
		"patrol_history": history,
		"patrol_sequence_no": next((row.get("sequence_no") for row in history if row.get("name") == doc.name), 0),
		"patrol_required_count": context.get("patrol_required_count") or 0,
		"patrol_accepted_count": context.get("patrol_accepted_count") or 0,
	}


def get_item_customer_code(item_code: str | None) -> str:
	if not item_code or not frappe.db.exists("Item", item_code):
		return ""
	meta = frappe.get_meta("Item")
	for fieldname in ("customer_code", "custom_客户料号"):
		if meta.has_field(fieldname):
			value = frappe.db.get_value("Item", item_code, fieldname)
			if value:
				return str(value).strip()
	return ""


def get_related_defect_alerts(doc) -> list[dict]:
	if not doc.get("scheduling_item"):
		return []
	names = frappe.get_all(
		"Production Quality Check",
		filters={
			"scheduling_item": doc.scheduling_item,
			"docstatus": ("<", 2),
			"name": ("!=", doc.name),
		},
		pluck="name",
		order_by="modified desc",
		limit_page_length=50,
	)
	alerts = []
	for name in names:
		alert_doc = frappe.get_doc("Production Quality Check", name)
		if not alert_doc.has_permission("read"):
			continue
		if not has_defect_alert_signal(alert_doc):
			continue
		alerts.append(
			{
				"name": alert_doc.name,
				"quality_node": alert_doc.quality_node,
				"overall_status": alert_doc.overall_status,
				"system_overall_status": alert_doc.get("system_overall_status"),
				"work_order": alert_doc.work_order,
				"item_code": alert_doc.item_code,
				"item_name": alert_doc.item_name,
				"modified": alert_doc.modified,
				"inspection_finished_at": alert_doc.inspection_finished_at,
				"inspector": alert_doc.get("inspector"),
				"summary": build_defect_summary(alert_doc),
				"remarks": alert_doc.remarks,
				"defects": [
					{
						"defect_code": row.defect_code,
						"defect_name": row.defect_name,
						"description": row.get("description"),
						"quantity": row.quantity,
						"remarks": row.remarks,
					}
					for row in alert_doc.get("defects", [])
				],
				"failed_readings": get_failed_readings(alert_doc),
			}
		)
		if len(alerts) >= 20:
			break
	return alerts


def has_defect_alert_signal(doc) -> bool:
	if doc.get("overall_status") == "Rejected" or doc.get("system_overall_status") == "Rejected":
		return True
	if float(doc.get("defect_sample_qty") or 0) > 0 or float(doc.get("defect_rate") or 0) > 0:
		return True
	if get_failed_readings(doc):
		return True
	return any(row.defect_code for row in doc.get("defects", []))


def build_defect_summary(doc) -> str:
	parts = []
	if doc.get("quality_node"):
		parts.append(_("Inspection Process") + ": " + _(doc.quality_node))
	result_status = doc.get("overall_status")
	if result_status != "Rejected" and doc.get("system_overall_status") == "Rejected":
		result_status = doc.get("system_overall_status")
	if result_status:
		parts.append(_("Result") + ": " + _(result_status))
	if doc.get("inspection_sample_qty"):
		parts.append(
			_("Defect Rate")
			+ ": {0:g}% ({1:g}/{2:g})".format(
				float(doc.get("defect_rate") or 0),
				float(doc.get("defect_sample_qty") or 0),
				float(doc.get("inspection_sample_qty") or 0),
			)
		)
	failed = get_failed_readings(doc)
	if failed:
		parts.append(
			_("Measurement") + ": " + "; ".join(
				[
					"{0}({1})".format(row.get("specification") or row.get("idx"), row.get("status") or _("Rejected"))
					for row in failed[:4]
				]
			)
		)
	defects = []
	for row in doc.get("defects", []):
		if not row.defect_code:
			continue
		text = row.defect_name or row.defect_code
		if row.quantity:
			text += " x {0:g}".format(float(row.quantity))
		if row.remarks:
			text += " - " + row.remarks
		defects.append(text)
	if defects:
		parts.append(_("Defects", None, "JCE Quality") + ": " + "; ".join(defects[:5]))
	if doc.get("remarks"):
		parts.append(_("Remarks") + ": " + doc.remarks)
	return " | ".join([part for part in parts if part])


def get_failed_readings(doc) -> list[dict]:
	failed = []
	for row in doc.get("sample_readings", []):
		if row.status != "Rejected":
			continue
		failed.append(
			{
				"idx": row.source_reading_idx or row.idx,
				"sample_no": row.sample_no,
				"specification": row.specification,
				"status": row.status,
				"reading_value": row.reading_value,
			}
		)
	if failed:
		return failed
	for row in doc.get("readings", []):
		if row.status not in ("Rejected", "Failed"):
			continue
		failed.append(
			{
				"idx": row.idx,
				"specification": row.specification,
				"status": row.status,
				"reading_value": row.reading_value,
			}
		)
	return failed


def update_scheduling_quality_alert(doc, alert_note: str):
	if not doc.scheduling_item or not frappe.db.exists("Scheduling Item", doc.scheduling_item):
		return
	meta = frappe.get_meta("Scheduling Item")
	values = {}
	if meta.has_field("jce_quality_alert_open"):
		values["jce_quality_alert_open"] = 1
	if meta.has_field("jce_quality_alert_source_check"):
		values["jce_quality_alert_source_check"] = doc.name
	if meta.has_field("jce_quality_alert_note"):
		values["jce_quality_alert_note"] = alert_note
	if values:
		frappe.db.set_value("Scheduling Item", doc.scheduling_item, values, update_modified=True)


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


def _set_sample_readings(doc, sample_readings):
	doc.set("sample_readings", [])
	readings_by_idx = {int(row.idx): row for row in doc.get("readings", [])}
	readings_by_spec = {row.specification: row for row in doc.get("readings", []) if row.specification}
	max_sample_no = 0
	for incoming in sample_readings or []:
		sample_no = int(incoming.get("sample_no") or 0)
		specification = incoming.get("specification")
		source_idx = int(incoming.get("source_reading_idx") or incoming.get("reading_idx") or 0)
		source = readings_by_idx.get(source_idx) or readings_by_spec.get(specification)
		if not sample_no or not (source or specification):
			continue
		max_sample_no = max(max_sample_no, sample_no)
		row = doc.append("sample_readings", {})
		row.sample_no = sample_no
		row.source_reading_idx = source.idx if source else source_idx
		row.specification = source.specification if source else specification
		row.reading_value = incoming.get("reading_value")
		for fieldname in (
			"parameter_group",
			"inspection_method",
			"inspection_standard",
			"value",
			"numeric",
			"min_value",
			"max_value",
			"formula_based_criteria",
			"acceptance_formula",
		):
			if source and row.meta.has_field(fieldname):
				row.set(fieldname, source.get(fieldname))
	if doc.meta.has_field("inspection_sample_qty"):
		doc.inspection_sample_qty = max(int(doc.get("inspection_sample_qty") or 1), max_sample_no, 1)
