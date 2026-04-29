from __future__ import annotations

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, flt, get_datetime, getdate, now_datetime, today

from erpnext.stock.doctype.quality_inspection.quality_inspection import parse_float
from erpnext.stock.doctype.quality_inspection_template.quality_inspection_template import (
	get_template_details,
)


QUALITY_NODES = ("First Article", "Patrol", "Last Article", "Final Release")
PASSING_STATUSES = ("Accepted", "Concession Released")
SCHEDULING_ITEM_STATUS_FIELDS = {
	"First Article": "jce_quality_first_article_status",
	"Last Article": "jce_quality_last_article_status",
	"Final Release": "jce_quality_final_release_status",
}
_UNSET = object()


def get_scheduling_item(row_name: str):
	if not row_name:
		frappe.throw(_("Scheduling Item Row is required."))
	return frappe.get_doc("Scheduling Item", row_name)


def get_scheduling_doc(docname: str):
	if not docname:
		frappe.throw(_("Work Order Scheduling is required."))
	return frappe.get_doc("Work Order Scheduling", docname)


def populate_check_from_scheduling(doc):
	if not doc.work_order_scheduling and doc.scheduling_item:
		doc.work_order_scheduling = frappe.db.get_value("Scheduling Item", doc.scheduling_item, "parent")

	if not (doc.work_order_scheduling and doc.scheduling_item):
		return

	row = get_scheduling_item(doc.scheduling_item)
	scheduling = get_scheduling_doc(doc.work_order_scheduling)
	if row.parent != scheduling.name:
		frappe.throw(_("Scheduling Item {0} does not belong to Work Order Scheduling {1}.").format(row.name, scheduling.name))

	doc.company = getattr(scheduling, "company", None)
	doc.posting_date = getattr(scheduling, "posting_date", None)
	doc.shift_type = getattr(scheduling, "shift_type", None)
	doc.plant_floor = getattr(scheduling, "plant_floor", None)
	doc.work_order = getattr(row, "work_order", None)
	doc.item_code = getattr(row, "item_code", None)
	doc.item_name = getattr(row, "item_name", None)
	doc.item_group = frappe.db.get_value("Item", doc.item_code, "item_group") if doc.item_code else None
	doc.workstation = getattr(row, "workstation", None)
	doc.scheduling_qty = flt(getattr(row, "scheduling_qty", 0))
	doc.completed_qty = flt(getattr(row, "completed_qty", 0))
	doc.defect_qty = flt(getattr(row, "defect_qty", 0))
	doc.mold = get_work_order_mold(doc.work_order)

	apply_rule_to_check(doc)


def apply_rule_to_check(doc):
	rule = get_applicable_rule(
		company=getattr(doc, "company", None),
		plant_floor=getattr(doc, "plant_floor", None),
		workstation=getattr(doc, "workstation", None),
		item_code=getattr(doc, "item_code", None),
		item_group=getattr(doc, "item_group", None),
		quality_node=getattr(doc, "quality_node", None),
	)
	if rule:
		doc.production_quality_rule = rule.name
		doc.quality_inspection_template = doc.quality_inspection_template or rule.quality_inspection_template
		doc.requires_sample = cint(rule.requires_sample)
		doc.required_sample_type = rule.required_sample_type
	else:
		doc.requires_sample = 1
		doc.quality_inspection_template = doc.quality_inspection_template or (
			frappe.db.get_value("Item", doc.item_code, "quality_inspection_template") if doc.item_code else None
		)


def get_work_order_mold(work_order: str | None) -> str | None:
	if not work_order or not frappe.db.exists("Work Order", work_order):
		return None

	meta = frappe.get_meta("Work Order")
	for fieldname in ("mold", "custom_mold", "tool", "custom_tool", "custom_tooling"):
		if meta.has_field(fieldname):
			return frappe.db.get_value("Work Order", work_order, fieldname)
	return None


def get_applicable_rule(
	company: str | None,
	plant_floor: str | None,
	workstation: str | None,
	item_code: str | None,
	item_group: str | None,
	quality_node: str | None,
	rules: list | None = None,
):
	if not quality_node or not frappe.db.exists("DocType", "Production Quality Rule"):
		return None

	if item_code and not item_group:
		item_group = frappe.db.get_value("Item", item_code, "item_group")

	rules = rules if rules is not None else get_enabled_quality_rules(quality_node)

	def matches(rule, fieldname, value):
		rule_value = rule.get(fieldname)
		return not rule_value or (value and rule_value == value)

	def score(rule):
		if not all(
			(
				matches(rule, "company", company),
				matches(rule, "plant_floor", plant_floor),
				matches(rule, "workstation", workstation),
				matches(rule, "item_code", item_code),
				matches(rule, "item_group", item_group),
			)
		):
			return -1

		return (
			(100 if rule.item_code else 0)
			+ (50 if rule.item_group else 0)
			+ (25 if rule.workstation else 0)
			+ (15 if rule.plant_floor else 0)
			+ (5 if rule.company else 0)
		)

	best_rule = None
	best_score = -1
	for rule in rules:
		rule_score = score(rule)
		if rule_score > best_score:
			best_rule = rule
			best_score = rule_score

	return frappe._dict(best_rule) if best_rule and best_score >= 0 else None


def get_enabled_quality_rules(quality_node: str | None = None):
	cache = getattr(frappe.local, "jce_quality_rule_cache", None)
	if cache is None:
		cache = {}
		frappe.local.jce_quality_rule_cache = cache

	cache_key = quality_node or "*"
	if cache_key in cache:
		return cache[cache_key]

	filters = {"disabled": 0}
	if quality_node:
		filters["quality_node"] = quality_node

	rules = frappe.get_all(
		"Production Quality Rule",
		filters=filters,
		fields=[
			"name",
			"company",
			"plant_floor",
			"workstation",
			"item_code",
			"item_group",
			"quality_inspection_template",
			"is_mandatory",
			"requires_sample",
			"required_sample_type",
			"minimum_patrol_count",
			"patrol_interval_mins",
			"modified",
		],
		order_by="modified desc, name desc",
	)
	cache[cache_key] = rules
	return rules


def get_item_group_map(item_codes):
	item_codes = sorted(set(filter(None, item_codes or [])))
	if not item_codes:
		return {}
	return {
		row.name: row.item_group
		for row in frappe.get_all("Item", filters={"name": ("in", item_codes)}, fields=["name", "item_group"])
	}


def get_quality_requirements(scheduling_doc, row, item_group=None, rules_by_node: dict | None = None):
	requirements = {}
	for node in QUALITY_NODES:
		rule = get_applicable_rule(
			company=scheduling_doc.company,
			plant_floor=scheduling_doc.plant_floor,
			workstation=row.workstation,
			item_code=row.item_code,
			item_group=item_group,
			quality_node=node,
			rules=(rules_by_node or {}).get(node),
		)
		requirements[node] = get_required_check_count(rule, node)
	return requirements


def get_required_check_count(rule, node: str) -> int:
	if rule and not cint(rule.is_mandatory):
		return 0

	if node == "Patrol":
		required_count = cint(rule.minimum_patrol_count) if rule else 1
		return required_count if required_count > 0 else 1

	return 1


def summary_meets_requirements(summary: dict, requirements: dict) -> bool:
	if summary.get("frozen"):
		return False
	if requirements.get("First Article") and summary.get("first_article_status") not in PASSING_STATUSES:
		return False
	if requirements.get("Last Article") and summary.get("last_article_status") not in PASSING_STATUSES:
		return False
	if requirements.get("Final Release") and summary.get("final_release_status") not in PASSING_STATUSES:
		return False
	if requirements.get("Patrol") and cint(summary.get("patrol_count")) < cint(requirements.get("Patrol")):
		return False
	return True


def load_template_readings(doc, force: bool = False):
	if not doc.quality_inspection_template:
		return
	if doc.get("readings") and not force:
		return

	doc.set("readings", [])
	for parameter in get_template_details(doc.quality_inspection_template):
		child = doc.append("readings", {})
		child.update(parameter)
		child.status = "Accepted"
		child.parameter_group = frappe.db.get_value(
			"Quality Inspection Parameter", parameter.specification, "parameter_group"
		)


def validate_sample_reference(doc):
	if not cint(doc.requires_sample):
		return

	if not frappe.db.exists("DocType", "Sample Manager"):
		frappe.throw(_("Sample Manager DocType is required before submitting this quality check."))

	if not doc.sample_manager:
		frappe.throw(_("Sample Manager is mandatory for {0}.").format(_(doc.quality_node)))

	sample = frappe.get_doc("Sample Manager", doc.sample_manager)
	if sample.status != "Active":
		frappe.throw(_("Sample {0} must be Active. Current status: {1}").format(sample.name, sample.status))

	if sample.get("exp_date") and getdate(sample.exp_date) < getdate():
		frappe.throw(_("Sample {0} expired on {1}.").format(sample.name, sample.exp_date))

	if doc.item_code and sample.get("against_item") != doc.item_code:
		frappe.throw(
			_("Sample {0} item {1} does not match inspection item {2}.").format(
				sample.name, sample.get("against_item") or "-", doc.item_code
			)
		)

	if doc.mold and sample.get("mold") and sample.mold != doc.mold:
		frappe.throw(_("Sample {0} mold {1} does not match required mold {2}.").format(sample.name, sample.mold, doc.mold))

	if doc.required_sample_type and sample.get("sample_type") != doc.required_sample_type:
		frappe.throw(
			_("Sample {0} type {1} does not match required type {2}.").format(
				sample.name, sample.get("sample_type") or "-", doc.required_sample_type
			)
		)

	doc.sample_ref = sample.get("sample_ref") or sample.name
	doc.sample_status = sample.status
	doc.sample_type = sample.get("sample_type")


def inspect_and_set_status(doc, require_values: bool = False):
	if cint(doc.manual_inspection):
		if require_values and doc.overall_status not in ("Accepted", "Rejected"):
			frappe.throw(_("Manual Result must be Accepted or Rejected before submit."))
		return doc.overall_status == "Accepted"

	rejected = False
	accepted_or_manual = False

	for reading in doc.get("readings", []):
		if cint(reading.manual_inspection):
			if require_values and not reading.status:
				frappe.throw(_("Row #{0}: Status is mandatory.").format(reading.idx))
			if reading.status == "Rejected":
				rejected = True
			elif reading.status == "Accepted":
				accepted_or_manual = True
			continue

		if cint(reading.formula_based_criteria):
			result = _formula_criteria_passed(reading)
		elif not cint(reading.numeric):
			result = (reading.get("reading_value") or "") == (reading.get("value") or "")
			if require_values and not str(reading.get("reading_value") or "").strip():
				frappe.throw(_("Row #{0}: Reading Value is mandatory.").format(reading.idx))
		else:
			result = _min_max_criteria_passed(reading, require_values=require_values)

		reading.status = "Accepted" if result else "Rejected"
		accepted_or_manual = accepted_or_manual or result
		rejected = rejected or not result

	if doc.get("readings"):
		doc.overall_status = "Rejected" if rejected else "Accepted"
	elif require_values:
		if not cint(doc.manual_inspection):
			frappe.throw(_("Readings are required unless Manual Result is checked."))
		if doc.overall_status not in ("Accepted", "Rejected"):
			frappe.throw(_("Manual Result must be Accepted or Rejected before submit."))

	return accepted_or_manual and not rejected


def _min_max_criteria_passed(reading, require_values: bool = False):
	has_reading = False
	for idx in range(1, 11):
		value = reading.get(f"reading_{idx}")
		if value is None or not str(value).strip():
			continue
		has_reading = True
		if not (flt(reading.get("min_value")) <= parse_float(str(value)) <= flt(reading.get("max_value"))):
			return False

	if require_values and not has_reading:
		frappe.throw(_("Row #{0}: At least one numeric reading is mandatory.").format(reading.idx))
	return has_reading


def _formula_criteria_passed(reading):
	if not reading.acceptance_formula:
		frappe.throw(_("Row #{0}: Acceptance Criteria Formula is required.").format(reading.idx))

	data = {"reading_value": reading.get("reading_value")}
	for idx in range(1, 11):
		value = reading.get(f"reading_{idx}")
		data[f"reading_{idx}"] = parse_float(str(value)) if value is not None and str(value).strip() else 0.0

	populated = [
		data[f"reading_{idx}"]
		for idx in range(1, 11)
		if reading.get(f"reading_{idx}") is not None and str(reading.get(f"reading_{idx}")).strip()
	]
	data["mean"] = sum(populated) / len(populated) if populated else 0.0
	return bool(frappe.safe_eval(reading.acceptance_formula, None, data))


def make_quality_checks(work_order_scheduling: str, scheduling_item: str | None = None, nodes: list[str] | None = None):
	doc = get_scheduling_doc(work_order_scheduling)
	nodes = nodes or list(QUALITY_NODES)
	created = []
	item_group_map = get_item_group_map([row.item_code for row in doc.scheduling_items])
	rules_by_node = {node: get_enabled_quality_rules(node) for node in QUALITY_NODES}

	for row in doc.scheduling_items:
		if scheduling_item and row.name != scheduling_item:
			continue
		for node in nodes:
			if node not in QUALITY_NODES:
				continue
			missing_count = get_missing_check_count(
				doc,
				row,
				node,
				item_group=item_group_map.get(row.item_code),
				rules_by_node=rules_by_node,
			)
			for _idx in range(missing_count):
				check = frappe.new_doc("Production Quality Check")
				check.quality_node = node
				check.work_order_scheduling = doc.name
				check.scheduling_item = row.name
				populate_check_from_scheduling(check)
				load_template_readings(check)
				check.insert(ignore_permissions=True)
				created.append(check.name)

	return created


def get_missing_check_count(scheduling_doc, scheduling_row, node: str, item_group=None, rules_by_node: dict | None = None) -> int:
	rule = get_applicable_rule(
		company=scheduling_doc.company,
		plant_floor=scheduling_doc.plant_floor,
		workstation=scheduling_row.workstation,
		item_code=scheduling_row.item_code,
		item_group=item_group,
		quality_node=node,
		rules=(rules_by_node or {}).get(node),
	)
	required_count = get_required_check_count(rule, node)
	if not required_count:
		return 0

	existing = frappe.db.count(
		"Production Quality Check",
		{
			"work_order_scheduling": scheduling_doc.name,
			"scheduling_item": scheduling_row.name,
			"quality_node": node,
			"docstatus": ("<", 2),
		},
	)
	return max(required_count - existing, 0)


def get_scheduling_item_quality_summary(scheduling_item: str):
	return get_scheduling_items_quality_summary([scheduling_item]).get(scheduling_item, _empty_quality_summary())


def get_scheduling_items_quality_summary(scheduling_items: list[str]):
	scheduling_items = list(dict.fromkeys(filter(None, scheduling_items or [])))
	if not scheduling_items:
		return {}

	summaries = {name: _empty_quality_summary() for name in scheduling_items}
	checks = frappe.get_all(
		"Production Quality Check",
		filters={"scheduling_item": ("in", scheduling_items), "docstatus": ("<", 2)},
		fields=["name", "scheduling_item", "quality_node", "overall_status", "status", "docstatus", "modified"],
		order_by="scheduling_item asc, modified desc",
	)

	for check in checks:
		summary = summaries.setdefault(check.scheduling_item, _empty_quality_summary())
		if not summary["latest_check"]:
			summary["latest_check"] = check.name
		if check.docstatus == 1 and check.overall_status == "Rejected":
			summary["frozen"] = True
		if check.quality_node == "Patrol" and check.docstatus == 1 and check.overall_status in PASSING_STATUSES:
			summary["patrol_count"] += 1
		if check.quality_node not in summary["_latest_by_node"]:
			summary["_latest_by_node"][check.quality_node] = check.overall_status if check.docstatus == 1 else "Pending"

	for summary in summaries.values():
		latest_by_node = summary.pop("_latest_by_node", {})
		summary["first_article_status"] = latest_by_node.get("First Article", "Pending")
		summary["last_article_status"] = latest_by_node.get("Last Article", "Pending")
		summary["final_release_status"] = latest_by_node.get("Final Release", "Pending")

	return summaries


def _empty_quality_summary():
	return {
		"latest_check": None,
		"frozen": False,
		"patrol_count": 0,
		"first_article_status": "Pending",
		"last_article_status": "Pending",
		"final_release_status": "Pending",
		"_latest_by_node": {},
	}


def sync_scheduling_item_quality_status(scheduling_item: str | None):
	if not scheduling_item or not frappe.db.exists("Scheduling Item", scheduling_item):
		return

	meta = frappe.get_meta("Scheduling Item")
	fields = {
		"jce_quality_first_article_status": "first_article_status",
		"jce_quality_patrol_count": "patrol_count",
		"jce_quality_last_article_status": "last_article_status",
		"jce_quality_final_release_status": "final_release_status",
		"jce_quality_frozen": "frozen",
		"jce_quality_latest_check": "latest_check",
	}
	summary = get_scheduling_item_quality_summary(scheduling_item)
	values = {fieldname: summary[key] for fieldname, key in fields.items() if meta.has_field(fieldname)}
	if values:
		frappe.db.set_value("Scheduling Item", scheduling_item, values, update_modified=False)


def validate_quality_gate_for_scheduling(work_order_scheduling: str):
	doc = get_scheduling_doc(work_order_scheduling)
	messages = []
	item_group_map = get_item_group_map([row.item_code for row in doc.scheduling_items])
	rules_by_node = {node: get_enabled_quality_rules(node) for node in QUALITY_NODES}
	checks_by_row_node = get_submitted_quality_checks_by_row_node(
		doc.name,
		[row.name for row in doc.scheduling_items],
	)

	for row in doc.scheduling_items:
		if not (flt(row.get("completed_qty")) or flt(row.get("defect_qty"))):
			continue
		messages.extend(
			validate_quality_gate_for_row(
				doc,
				row,
				item_group=item_group_map.get(row.item_code),
				rules_by_node=rules_by_node,
				checks_by_row_node=checks_by_row_node,
			)
		)

	if messages:
		frappe.throw("<br>".join(messages), title=_("Quality Gate Not Passed"))


def validate_quality_gate_for_row(
	scheduling_doc,
	row,
	item_group=None,
	rules_by_node: dict | None = None,
	checks_by_row_node: dict | None = None,
):
	messages = []
	for node in QUALITY_NODES:
		rule = get_applicable_rule(
			company=scheduling_doc.company,
			plant_floor=scheduling_doc.plant_floor,
			workstation=row.workstation,
			item_code=row.item_code,
			item_group=item_group,
			quality_node=node,
			rules=(rules_by_node or {}).get(node),
		)
		required_count = get_required_check_count(rule, node)
		if not required_count:
			continue

		if checks_by_row_node is not None:
			checks = checks_by_row_node.get((row.name, node), [])
		else:
			checks = frappe.get_all(
				"Production Quality Check",
				filters={
					"work_order_scheduling": scheduling_doc.name,
					"scheduling_item": row.name,
					"quality_node": node,
					"docstatus": 1,
				},
				fields=["name", "overall_status"],
				order_by="modified desc",
			)

		blocking = [check for check in checks if check.overall_status == "Rejected"]
		if blocking:
			messages.append(
				_("Row {0} {1}: {2} has rejected quality check {3}.").format(
					row.idx, row.item_code, _(node), blocking[0].name
				)
			)
			continue

		passing_count = len([check for check in checks if check.overall_status in PASSING_STATUSES])
		if passing_count < required_count:
			messages.append(
				_("Row {0} {1}: {2} requires {3} accepted check(s), found {4}.").format(
					row.idx, row.item_code, _(node), required_count, passing_count
				)
			)

	return messages


def get_submitted_quality_checks_by_row_node(work_order_scheduling: str, scheduling_items: list[str]):
	scheduling_items = list(dict.fromkeys(filter(None, scheduling_items or [])))
	if not scheduling_items:
		return {}

	checks = frappe.get_all(
		"Production Quality Check",
		filters={
			"work_order_scheduling": work_order_scheduling,
			"scheduling_item": ("in", scheduling_items),
			"quality_node": ("in", QUALITY_NODES),
			"docstatus": 1,
		},
		fields=["name", "scheduling_item", "quality_node", "overall_status", "modified"],
		order_by="scheduling_item asc, quality_node asc, modified desc",
	)
	grouped = defaultdict(list)
	for check in checks:
		grouped[(check.scheduling_item, check.quality_node)].append(check)
	return grouped


def validate_stock_entry_quality_gate(doc, method=None):
	if doc.purpose != "Manufacture":
		return

	work_order_scheduling = doc.get("work_order_scheduling") or doc.get("custom_work_order_scheduling")
	if work_order_scheduling:
		validate_quality_gate_for_scheduling(work_order_scheduling)


def get_work_order_scheduling_summary(work_order_scheduling: str):
	doc = get_scheduling_doc(work_order_scheduling)
	total = len(doc.scheduling_items)
	frozen = 0
	complete = 0
	pending = 0
	summaries = get_scheduling_items_quality_summary([row.name for row in doc.scheduling_items])
	item_group_map = get_item_group_map([row.item_code for row in doc.scheduling_items])
	rules_by_node = {node: get_enabled_quality_rules(node) for node in QUALITY_NODES}
	for row in doc.scheduling_items:
		summary = summaries.get(row.name, _empty_quality_summary())
		requirements = get_quality_requirements(
			doc,
			row,
			item_group=item_group_map.get(row.item_code),
			rules_by_node=rules_by_node,
		)
		if summary["frozen"]:
			frozen += 1
		if summary_meets_requirements(summary, requirements):
			complete += 1
		else:
			pending += 1

	return {"total": total, "complete": complete, "pending": pending, "frozen": frozen}


def get_patrol_task_info(scheduling_doc, row, summary: dict, rule=_UNSET, latest_patrol_at=_UNSET, item_group=None):
	if rule is _UNSET:
		rule = get_applicable_rule(
			company=scheduling_doc.company,
			plant_floor=scheduling_doc.plant_floor,
			workstation=row.workstation,
			item_code=row.item_code,
			item_group=item_group,
			quality_node="Patrol",
		)

	required_count = get_required_check_count(rule, "Patrol")
	interval_mins = cint(rule.patrol_interval_mins) if rule and required_count else 0
	if latest_patrol_at is _UNSET:
		latest_patrol_at = frappe.db.get_value(
			"Production Quality Check",
			filters={
				"work_order_scheduling": scheduling_doc.name,
				"scheduling_item": row.name,
				"quality_node": "Patrol",
				"docstatus": 1,
				"overall_status": ("in", PASSING_STATUSES),
			},
			fieldname="inspection_finished_at",
			order_by="inspection_finished_at desc, modified desc",
		)

	overdue = False
	next_due_at = None
	if (
		interval_mins
		and not summary.get("frozen")
		and summary.get("final_release_status") not in PASSING_STATUSES
	):
		baseline = latest_patrol_at or row.get("from_time")
		if baseline:
			deadline = add_to_date(get_datetime(baseline), minutes=interval_mins)
			next_due_at = get_datetime(deadline)
			overdue = next_due_at <= now_datetime()

	return {
		"patrol_required_count": required_count,
		"patrol_interval_mins": interval_mins,
		"latest_patrol_at": latest_patrol_at,
		"next_patrol_due_at": next_due_at,
		"patrol_due": overdue,
		"patrol_overdue": overdue,
	}


def get_latest_accepted_patrol_map(scheduling_items: list[str]):
	scheduling_items = list(dict.fromkeys(filter(None, scheduling_items or [])))
	if not scheduling_items:
		return {}

	rows = frappe.get_all(
		"Production Quality Check",
		filters={
			"scheduling_item": ("in", scheduling_items),
			"quality_node": "Patrol",
			"docstatus": 1,
			"overall_status": ("in", PASSING_STATUSES),
		},
		fields=["scheduling_item", "inspection_finished_at", "modified"],
		order_by="scheduling_item asc, inspection_finished_at desc, modified desc",
	)
	latest = {}
	for row in rows:
		if row.scheduling_item not in latest:
			latest[row.scheduling_item] = row.inspection_finished_at
	return latest


def get_terminal_tasks(posting_date=None, plant_floor=None, shift_type=None, work_order_scheduling=None):
	filters = {}
	if work_order_scheduling:
		filters["name"] = work_order_scheduling
	if posting_date:
		filters["posting_date"] = posting_date
	if plant_floor:
		filters["plant_floor"] = plant_floor
	if shift_type:
		filters["shift_type"] = shift_type

	schedules = frappe.get_all(
		"Work Order Scheduling",
		filters=filters,
		fields=["name", "posting_date", "company", "plant_floor", "shift_type", "status"],
		order_by="posting_date desc, modified desc",
		limit_page_length=50,
	)
	if not schedules:
		return []

	schedule_map = {schedule.name: schedule for schedule in schedules}
	schedule_names = list(schedule_map)
	rows = frappe.get_all(
		"Scheduling Item",
		filters={"parent": ("in", schedule_names)},
		fields=[
			"name",
			"parent",
			"idx",
			"work_order",
			"item_code",
			"item_name",
			"scheduling_qty",
			"completed_qty",
			"defect_qty",
			"workstation",
			"from_time",
			"to_time",
		],
		order_by="parent asc, idx asc",
	)
	summaries = get_scheduling_items_quality_summary([row.name for row in rows])
	latest_patrol_map = get_latest_accepted_patrol_map([row.name for row in rows])
	item_group_map = get_item_group_map([row.item_code for row in rows])
	rules_by_node = {node: get_enabled_quality_rules(node) for node in QUALITY_NODES}

	tasks = []
	for row in rows:
		schedule = schedule_map.get(row.parent)
		if not schedule:
			continue
		item_group = item_group_map.get(row.item_code)
		summary = summaries.get(row.name, _empty_quality_summary())
		requirements = get_quality_requirements(schedule, row, item_group=item_group, rules_by_node=rules_by_node)
		patrol_rule = get_applicable_rule(
			company=schedule.company,
			plant_floor=schedule.plant_floor,
			workstation=row.workstation,
			item_code=row.item_code,
			item_group=item_group,
			quality_node="Patrol",
			rules=rules_by_node.get("Patrol"),
		)
		patrol_info = get_patrol_task_info(
			schedule,
			row,
			summary,
			rule=patrol_rule,
			latest_patrol_at=latest_patrol_map.get(row.name),
			item_group=item_group,
		)
		tasks.append(
			{
				**schedule,
				**row,
				**summary,
				**patrol_info,
				"work_order_scheduling": schedule.name,
				"first_article_required": requirements.get("First Article", 0),
				"last_article_required": requirements.get("Last Article", 0),
				"final_release_required": requirements.get("Final Release", 0),
				"quality_complete": summary_meets_requirements(summary, requirements),
			}
		)

	return tasks


def get_board_data(posting_date=None, plant_floor=None, shift_type=None):
	tasks = get_terminal_tasks(posting_date=posting_date, plant_floor=plant_floor, shift_type=shift_type)
	metrics = defaultdict(int)
	by_workstation = defaultdict(lambda: {"total": 0, "complete": 0, "frozen": 0})

	for task in tasks:
		metrics["total_rows"] += 1
		if task.get("first_article_required") and task.get("first_article_status") == "Pending":
			metrics["pending_first_article"] += 1
		if task.get("last_article_required") and task.get("last_article_status") == "Pending":
			metrics["pending_last_article"] += 1
		if task.get("final_release_required") and task.get("final_release_status") == "Pending":
			metrics["pending_release"] += 1
		if task.get("frozen"):
			metrics["ng_frozen"] += 1
		if task.get("patrol_required_count") and cint(task.get("patrol_count")) < cint(task.get("patrol_required_count")):
			metrics["pending_patrol"] += 1
		if task.get("patrol_overdue"):
			metrics["patrol_overdue"] += 1

		workstation = task.get("workstation") or "-"
		by_workstation[workstation]["total"] += 1
		if task.get("frozen"):
			by_workstation[workstation]["frozen"] += 1
		if task.get("quality_complete"):
			by_workstation[workstation]["complete"] += 1

	return {
		"metrics": dict(metrics),
		"by_workstation": [{"workstation": key, **value} for key, value in by_workstation.items()],
		"tasks": tasks,
	}


def mark_disposition(doc, disposition: str, remarks: str | None = None):
	if doc.overall_status != "Rejected":
		frappe.throw(_("Disposition is only required for rejected checks."))
	if disposition not in ("Rework", "Scrap", "Concession Release"):
		frappe.throw(_("Invalid disposition {0}.").format(disposition))

	doc.db_set("disposition", disposition, update_modified=False)
	doc.db_set("disposition_remarks", remarks, update_modified=False)
	doc.db_set("disposition_by", frappe.session.user, update_modified=False)
	doc.db_set("disposition_at", now_datetime(), update_modified=True)
	sync_scheduling_item_quality_status(doc.scheduling_item)


def approve_concession_release(doc):
	if "Quality Manager" not in frappe.get_roles():
		frappe.throw(_("Only Quality Manager can approve concession release."))
	if doc.overall_status != "Rejected" or doc.disposition != "Concession Release":
		frappe.throw(_("Only rejected checks with Concession Release disposition can be approved."))

	doc.db_set("release_approved", 1, update_modified=False)
	doc.db_set("release_approved_by", frappe.session.user, update_modified=False)
	doc.db_set("release_approved_at", now_datetime(), update_modified=False)
	doc.db_set("overall_status", "Concession Released", update_modified=False)
	doc.db_set("status", "Concession Released", update_modified=True)
	sync_scheduling_item_quality_status(doc.scheduling_item)


def get_defect_code_options(txt: str | None = None):
	filters = {"disabled": 0}
	if txt:
		filters["defect_code"] = ("like", f"%{txt}%")
	return frappe.get_all(
		"Quality Defect Code",
		filters=filters,
		fields=["name", "defect_code", "defect_name", "category", "severity"],
		order_by="defect_code asc",
		limit_page_length=50,
	)


def get_quality_analytics_data(filters=None):
	filters = frappe.parse_json(filters) if isinstance(filters, str) else frappe._dict(filters or {})
	from_date = filters.get("from_date") or add_days(today(), -30)
	to_date = filters.get("to_date") or today()
	dimension = filters.get("dimension") or "workstation"
	if dimension not in ("mold", "item_code", "workstation"):
		dimension = "workstation"

	check_filters = {
		"docstatus": 1,
		"posting_date": ("between", [from_date, to_date]),
	}
	for fieldname in ("plant_floor", "shift_type", "quality_node"):
		if filters.get(fieldname):
			check_filters[fieldname] = filters.get(fieldname)
	if cint(filters.get("only_ng")):
		check_filters["overall_status"] = "Rejected"

	checks = frappe.get_all(
		"Production Quality Check",
		filters=check_filters,
		fields=[
			"name",
			"posting_date",
			"quality_node",
			"overall_status",
			"work_order_scheduling",
			"scheduling_item",
			"work_order",
			"item_code",
			"item_name",
			"mold",
			"workstation",
			"plant_floor",
			"shift_type",
			"completed_qty",
			"defect_qty",
			"modified",
		],
		order_by="posting_date asc, modified desc",
		limit_page_length=1000,
	)
	check_names = [row.name for row in checks]
	defects = []
	if check_names:
		defects = frappe.get_all(
			"Production Quality Defect",
			filters={"parenttype": "Production Quality Check", "parent": ("in", check_names)},
			fields=["parent", "defect_code", "defect_name", "category", "severity", "quantity", "remarks"],
			order_by="idx asc",
			limit_page_length=5000,
		)

	defects_by_parent = defaultdict(list)
	for defect in defects:
		defects_by_parent[defect.parent].append(defect)

	trend = defaultdict(lambda: _empty_analytics_bucket())
	by_dimension = defaultdict(lambda: _empty_analytics_bucket())
	defect_ranking = defaultdict(lambda: {"defect_code": "", "defect_name": "", "category": "", "severity": "", "quantity": 0})
	row_seen_by_date = set()
	row_seen_by_dimension = set()
	details = []

	for check in checks:
		date_key = str(check.posting_date)
		dimension_value = check.get(dimension) or "-"
		production_key = check.scheduling_item or check.name
		_check_bucket(trend[date_key], check)
		_check_bucket(by_dimension[dimension_value], check)

		if (date_key, production_key) not in row_seen_by_date:
			_add_production_qty(trend[date_key], check)
			row_seen_by_date.add((date_key, production_key))
		if (dimension_value, production_key) not in row_seen_by_dimension:
			_add_production_qty(by_dimension[dimension_value], check)
			row_seen_by_dimension.add((dimension_value, production_key))

		defect_total = 0
		defect_codes = []
		for defect in defects_by_parent.get(check.name, []):
			qty = flt(defect.quantity)
			defect_total += qty
			defect_codes.append(defect.defect_code)
			_add_defect_qty(trend[date_key], qty)
			_add_defect_qty(by_dimension[dimension_value], qty)
			key = defect.defect_code or "-"
			defect_ranking[key].update(
				{
					"defect_code": defect.defect_code or "-",
					"defect_name": defect.defect_name or defect.defect_code or "-",
					"category": defect.category,
					"severity": defect.severity,
				}
			)
			defect_ranking[key]["quantity"] += qty

		details.append(
			{
				**check,
				"production_qty": flt(check.completed_qty) + flt(check.defect_qty),
				"production_defect_rate": _rate(flt(check.defect_qty), flt(check.completed_qty) + flt(check.defect_qty)),
				"defect_total": defect_total,
				"defect_codes": ", ".join(sorted(set(filter(None, defect_codes)))),
			}
		)

	trend_rows = [_finish_bucket({"date": key, **value}) for key, value in sorted(trend.items())]
	dimension_rows = [_finish_bucket({"dimension": key, **value}) for key, value in by_dimension.items()]
	dimension_rows.sort(key=lambda row: (row.get("defect_count", 0), row.get("rejected_checks", 0)), reverse=True)
	defect_rows = sorted(defect_ranking.values(), key=lambda row: row.get("quantity", 0), reverse=True)

	metrics = _finish_bucket(_merge_buckets(trend.values()))
	return {
		"filters": {"from_date": from_date, "to_date": to_date, "dimension": dimension},
		"metrics": metrics,
		"trend": trend_rows,
		"by_dimension": dimension_rows[:20],
		"defect_ranking": defect_rows[:20],
		"details": details[:200],
	}


def _empty_analytics_bucket():
	return {
		"production_qty": 0,
		"production_defect_qty": 0,
		"submitted_checks": 0,
		"rejected_checks": 0,
		"defect_count": 0,
	}


def _check_bucket(bucket, check):
	bucket["submitted_checks"] += 1
	if check.overall_status == "Rejected":
		bucket["rejected_checks"] += 1


def _add_production_qty(bucket, check):
	bucket["production_qty"] += flt(check.completed_qty) + flt(check.defect_qty)
	bucket["production_defect_qty"] += flt(check.defect_qty)


def _add_defect_qty(bucket, quantity):
	bucket["defect_count"] += flt(quantity)


def _finish_bucket(bucket):
	bucket["production_defect_rate"] = _rate(bucket.get("production_defect_qty"), bucket.get("production_qty"))
	bucket["inspection_ng_rate"] = _rate(bucket.get("rejected_checks"), bucket.get("submitted_checks"))
	return bucket


def _merge_buckets(buckets):
	merged = _empty_analytics_bucket()
	for bucket in buckets:
		for key in merged:
			merged[key] += flt(bucket.get(key))
	return merged


def _rate(numerator, denominator):
	denominator = flt(denominator)
	return flt(numerator) / denominator if denominator else 0
