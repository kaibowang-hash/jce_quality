from __future__ import annotations

import hashlib
from collections import defaultdict
from contextlib import contextmanager

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, flt, get_datetime, getdate, now_datetime, today

from erpnext.stock.doctype.quality_inspection.quality_inspection import parse_float
from erpnext.stock.doctype.quality_inspection_template.quality_inspection_template import (
	get_template_details,
)

from jce_quality.services.template_baseline import apply_template_to_check


QUALITY_NODES = ("First Article", "Patrol", "Last Article", "Final Release")
READING_TEMPLATE_METADATA_FIELDS = ("inspection_method", "inspection_standard")
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
	apply_template_to_check(doc)


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
		doc.sample_manager = doc.sample_manager or rule.get("reference_sample")
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
			"reference_sample",
			"minimum_patrol_count",
			"patrol_interval_mins",
			"max_defect_rate",
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


def get_item_customer_code_map(item_codes):
	item_codes = sorted(set(filter(None, item_codes or [])))
	if not item_codes:
		return {}
	meta = frappe.get_meta("Item")
	fields = ["name"]
	for fieldname in ("customer_code", "custom_客户料号"):
		if meta.has_field(fieldname):
			fields.append(fieldname)
	if len(fields) == 1:
		return {}
	return {
		row.name: clean_customer_code(row)
		for row in frappe.get_all("Item", filters={"name": ("in", item_codes)}, fields=fields)
	}


def clean_customer_code(row) -> str:
	return (row.get("customer_code") or row.get("custom_客户料号") or "").strip()


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
		requirements[node] = get_required_check_count(rule, node, scheduling_row=row)
	return requirements


def get_required_check_count(rule, node: str, scheduling_row=None) -> int:
	if rule and not cint(rule.is_mandatory):
		return 0

	if node == "Patrol":
		required_count = cint(rule.minimum_patrol_count) if rule else 1
		required_count = required_count if required_count > 0 else 1
		return required_count + get_extra_patrol_count(scheduling_row)

	return 1


def get_extra_patrol_count(scheduling_row=None) -> int:
	if not scheduling_row:
		return 0
	return max(cint(getattr(scheduling_row, "jce_quality_extra_patrol_count", 0)), 0)


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

	template_metadata = get_template_parameter_metadata(doc.quality_inspection_template)
	doc.set("readings", [])
	for parameter in get_template_details(doc.quality_inspection_template):
		child = doc.append("readings", {})
		child.update(parameter)
		child.status = "Accepted"
		child.parameter_group = frappe.db.get_value(
			"Quality Inspection Parameter", parameter.specification, "parameter_group"
		)
		for fieldname, value in template_metadata.get(parameter.specification, {}).items():
			if child.meta.has_field(fieldname):
				child.set(fieldname, value)


def get_template_parameter_metadata(template_name: str | None) -> dict[str, dict]:
	if not template_name or not frappe.db.exists("Quality Inspection Template", template_name):
		return {}
	template = frappe.get_doc("Quality Inspection Template", template_name)
	rows = {}
	for row in template.get("item_quality_inspection_parameter", []):
		if not row.get("specification"):
			continue
		values = {
			fieldname: row.get(fieldname)
			for fieldname in READING_TEMPLATE_METADATA_FIELDS
			if row.meta.has_field(fieldname) and row.get(fieldname)
		}
		if values:
			rows[row.specification] = values
	return rows


def sync_reading_template_metadata(doc) -> bool:
	if not doc.get("quality_inspection_template") or not doc.get("readings"):
		return False
	template_metadata = get_template_parameter_metadata(doc.quality_inspection_template)
	if not template_metadata:
		return False
	changed = False
	for reading in doc.get("readings", []):
		for fieldname, value in template_metadata.get(reading.specification, {}).items():
			if reading.meta.has_field(fieldname) and not reading.get(fieldname):
				reading.set(fieldname, value)
				changed = True
	return changed


def prepare_check_for_terminal(doc, persist: bool = False):
	initial = {
		"quality_inspection_template": doc.get("quality_inspection_template"),
		"template_version": doc.get("template_version"),
		"template_af_reference": doc.get("template_af_reference"),
		"drawing_file": doc.get("drawing_file"),
		"template_warning": doc.get("template_warning"),
		"readings": len(doc.get("readings") or []),
		"inspection_stage": doc.get("inspection_stage"),
		"inspection_sample_qty": cint(doc.get("inspection_sample_qty")),
	}
	apply_template_to_check(doc)
	if not doc.docstatus:
		load_template_readings(doc)
		apply_sample_plan_to_check(doc)
	metadata_changed = sync_reading_template_metadata(doc)

	changed = any(
		initial.get(fieldname) != (
			len(doc.get("readings") or []) if fieldname == "readings" else doc.get(fieldname)
		)
		for fieldname in initial
	) or metadata_changed
	if persist and changed and not doc.docstatus:
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
	return doc


def get_template_sample_plan(template_name: str | None, quality_node: str | None = None) -> list[dict]:
	if not template_name or not frappe.db.exists("Quality Inspection Template", template_name):
		return []
	if not frappe.get_meta("Quality Inspection Template").has_field("sample_plan"):
		return []
	template = frappe.get_doc("Quality Inspection Template", template_name)
	rows = []
	for row in template.get("sample_plan", []):
		if quality_node and row.quality_node and row.quality_node != quality_node:
			continue
		rows.append(
			{
				"quality_node": row.quality_node,
				"stage_label": row.stage_label or row.quality_node or _("Default"),
				"min_sample_qty": max(cint(row.min_sample_qty), 1),
			}
		)
	return rows


def apply_sample_plan_to_check(doc) -> bool:
	if not doc.meta.has_field("inspection_sample_qty"):
		return False
	plans = get_template_sample_plan(doc.get("quality_inspection_template"), doc.get("quality_node"))
	current_stage = doc.get("inspection_stage")
	selected = None
	if current_stage:
		selected = next((row for row in plans if row.get("stage_label") == current_stage), None)
	selected = selected or (plans[0] if plans else None)
	stage = selected.get("stage_label") if selected else (current_stage or doc.get("quality_node") or _("Default"))
	min_qty = max(cint(selected.get("min_sample_qty")) if selected else 1, 1)
	current_qty = cint(doc.get("inspection_sample_qty"))
	changed = False
	if doc.meta.has_field("inspection_stage") and not current_stage and stage:
		doc.inspection_stage = stage
		changed = True
	if current_qty < min_qty:
		doc.inspection_sample_qty = min_qty
		changed = True
	return changed


def get_rule_max_defect_rate(doc) -> float:
	if doc.get("production_quality_rule") and frappe.db.exists("Production Quality Rule", doc.production_quality_rule):
		if frappe.get_meta("Production Quality Rule").has_field("max_defect_rate"):
			return max(flt(frappe.db.get_value("Production Quality Rule", doc.production_quality_rule, "max_defect_rate")), 0)
	rule = get_applicable_rule(
		company=doc.get("company"),
		plant_floor=doc.get("plant_floor"),
		workstation=doc.get("workstation"),
		item_code=doc.get("item_code"),
		item_group=doc.get("item_group"),
		quality_node=doc.get("quality_node"),
	)
	return max(flt(rule.get("max_defect_rate")) if rule else 0, 0)


def validate_sample_reference(doc):
	if not cint(doc.requires_sample):
		return

	if not frappe.db.exists("DocType", "Sample Manager"):
		frappe.throw(_("Reference Sample DocType is required before submitting this quality check."))

	if not doc.sample_manager:
		frappe.throw(_("Reference Sample is mandatory for {0}.").format(_(doc.quality_node)))

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
	if doc.meta.has_field("sample_readings") and doc.get("sample_readings"):
		system_passed = inspect_sample_readings(doc, require_values=require_values)
		return apply_manual_override(doc, system_passed, require_values=inspect_has_required_values(require_values))

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

	if doc.get("readings") and accepted_or_manual:
		system_status = "Rejected" if rejected else "Accepted"
		set_if_has_field(doc, "system_overall_status", system_status)
		if not cint(doc.manual_inspection):
			doc.overall_status = system_status
	elif require_values:
		if not cint(doc.manual_inspection):
			frappe.throw(_("Readings are required unless Manual Result is checked."))
		if doc.overall_status not in ("Accepted", "Rejected"):
			frappe.throw(_("Manual Result must be Accepted or Rejected before submit."))

	return apply_manual_override(doc, accepted_or_manual and not rejected, require_values=inspect_has_required_values(require_values))


def inspect_has_required_values(require_values: bool) -> bool:
	return bool(require_values)


def apply_manual_override(doc, system_passed: bool, require_values: bool = False):
	if not cint(doc.manual_inspection):
		return system_passed
	if require_values and doc.overall_status not in ("Accepted", "Rejected"):
		frappe.throw(_("Manual Result must be Accepted or Rejected before submit."))
	if (
		require_values
		and doc.get("system_overall_status")
		and doc.overall_status in ("Accepted", "Rejected")
		and doc.overall_status != doc.system_overall_status
		and not (doc.get("remarks") or "").strip()
	):
		frappe.throw(_("Operator Note is required when manually overriding the system result."))
	return doc.overall_status == "Accepted"


def inspect_sample_readings(doc, require_values: bool = False):
	sync_sample_reading_criteria(doc)
	sample_qty = max(cint(doc.get("inspection_sample_qty")), max([cint(row.sample_no) for row in doc.get("sample_readings", [])] or [0]), 1)
	expected_specs = {row.specification for row in doc.get("readings", []) if row.specification}
	if require_values and not expected_specs:
		frappe.throw(_("Readings are required unless Manual Result is checked."))

	by_sample = defaultdict(dict)
	any_value = False
	for row in doc.get("sample_readings", []):
		if not row.sample_no or not row.specification:
			continue
		value = row.get("reading_value")
		has_value = value is not None and str(value).strip()
		if has_value:
			any_value = True
			passed = sample_reading_passed(row)
			row.status = "Accepted" if passed else "Rejected"
		elif require_values:
			frappe.throw(
				_("Sample #{0} {1}: Reading Value is mandatory.").format(row.sample_no, row.specification)
			)
		else:
			row.status = ""
		by_sample[cint(row.sample_no)][row.specification] = row

	if require_values:
		for sample_no in range(1, sample_qty + 1):
			missing = expected_specs - set(by_sample.get(sample_no, {}).keys())
			if missing:
				frappe.throw(
					_("Sample #{0}: missing reading for {1}.").format(sample_no, ", ".join(sorted(missing)))
				)

	def sample_failed(sample_no):
		rows = by_sample.get(sample_no, {}).values()
		return any(row.status == "Rejected" for row in rows)

	def sample_has_value(sample_no):
		rows = by_sample.get(sample_no, {}).values()
		return any(str(row.get("reading_value") or "").strip() for row in rows)

	evaluated_samples = [sample_no for sample_no in range(1, sample_qty + 1) if sample_has_value(sample_no)]
	if require_values:
		evaluated_samples = list(range(1, sample_qty + 1))
	defect_sample_qty = sum(1 for sample_no in evaluated_samples if sample_failed(sample_no))
	denominator = sample_qty if require_values else len(evaluated_samples)
	defect_rate = (defect_sample_qty / denominator * 100) if denominator else 0
	max_defect_rate = get_rule_max_defect_rate(doc)
	system_status = "Rejected" if denominator and defect_rate > max_defect_rate else "Accepted"
	if not any_value and not require_values:
		system_status = "Pending"

	set_if_has_field(doc, "inspection_sample_qty", sample_qty)
	set_if_has_field(doc, "defect_sample_qty", defect_sample_qty)
	set_if_has_field(doc, "defect_rate", defect_rate)
	set_if_has_field(doc, "system_overall_status", system_status)
	if system_status != "Pending":
		for reading in doc.get("readings", []):
			rows = [
				row for row in doc.get("sample_readings", [])
				if row.specification == reading.specification and row.status
			]
			if rows:
				reading.status = "Rejected" if any(row.status == "Rejected" for row in rows) else "Accepted"
		if not cint(doc.manual_inspection):
			doc.overall_status = system_status
	return system_status == "Accepted"


def sync_sample_reading_criteria(doc):
	readings_by_idx = {cint(row.idx): row for row in doc.get("readings", [])}
	readings_by_spec = {row.specification: row for row in doc.get("readings", []) if row.specification}
	for row in doc.get("sample_readings", []):
		source = readings_by_idx.get(cint(row.source_reading_idx)) or readings_by_spec.get(row.specification)
		if not source:
			continue
		row.source_reading_idx = source.idx
		for fieldname in (
			"specification",
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
			if row.meta.has_field(fieldname):
				row.set(fieldname, source.get(fieldname))


def sample_reading_passed(row):
	value = row.get("reading_value")
	if cint(row.get("formula_based_criteria")):
		return sample_formula_criteria_passed(row, value)
	if not cint(row.get("numeric")):
		return (value or "") == (row.get("value") or "")
	return flt(row.get("min_value")) <= parse_float(str(value)) <= flt(row.get("max_value"))


def sample_formula_criteria_passed(row, value):
	if not row.acceptance_formula:
		frappe.throw(_("Sample #{0} {1}: Acceptance Criteria Formula is required.").format(row.sample_no, row.specification))
	parsed = parse_float(str(value)) if value is not None and str(value).strip() else 0.0
	data = {"reading_value": value, "mean": parsed}
	for idx in range(1, 11):
		data[f"reading_{idx}"] = parsed if idx == 1 else 0.0
	return bool(frappe.safe_eval(row.acceptance_formula, None, data))


def set_if_has_field(doc, fieldname, value):
	if doc.meta.has_field(fieldname):
		doc.set(fieldname, value)


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


@contextmanager
def quality_check_creation_lock(scheduling_item: str, node: str):
	lock_name = "jce_qc:" + hashlib.sha1(f"{scheduling_item}:{node}".encode()).hexdigest()
	acquired = False
	try:
		result = frappe.db.sql("select get_lock(%s, %s)", (lock_name, 10))
		acquired = bool(result and cint(result[0][0]))
		if not acquired:
			frappe.throw(_("Could not lock quality check creation. Please retry."))
		yield
	finally:
		if acquired:
			frappe.db.sql("select release_lock(%s)", (lock_name,))


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
			with quality_check_creation_lock(row.name, node):
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
	required_count = get_required_check_count(rule, node, scheduling_row=scheduling_row)
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
			if check.quality_node not in summary["_rejected_by_node"]:
				summary["_rejected_by_node"][check.quality_node] = "Rejected"
		if check.quality_node == "Patrol" and check.docstatus == 1 and check.overall_status in PASSING_STATUSES:
			summary["patrol_count"] += 1
		if check.quality_node not in summary["_latest_by_node"]:
			summary["_latest_by_node"][check.quality_node] = check.overall_status if check.docstatus == 1 else "Pending"

	for summary in summaries.values():
		latest_by_node = summary.pop("_latest_by_node", {})
		rejected_by_node = summary.pop("_rejected_by_node", {})
		summary["first_article_status"] = rejected_by_node.get("First Article") or latest_by_node.get("First Article", "Pending")
		summary["patrol_status"] = rejected_by_node.get("Patrol") or latest_by_node.get("Patrol", "Pending")
		summary["last_article_status"] = rejected_by_node.get("Last Article") or latest_by_node.get("Last Article", "Pending")
		summary["final_release_status"] = rejected_by_node.get("Final Release") or latest_by_node.get("Final Release", "Pending")

	return summaries


def _empty_quality_summary():
	return {
		"latest_check": None,
		"frozen": False,
		"patrol_count": 0,
		"first_article_status": "Pending",
		"patrol_status": "Pending",
		"last_article_status": "Pending",
		"final_release_status": "Pending",
		"_latest_by_node": {},
		"_rejected_by_node": {},
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
	messages = get_quality_gate_messages_for_scheduling(work_order_scheduling)
	if messages:
		frappe.throw("<br>".join(messages), title=_("Quality Gate Not Passed"))


def get_quality_gate_messages_for_scheduling(work_order_scheduling: str):
	return _get_quality_gate_messages_for_scheduling(work_order_scheduling)


def _get_quality_gate_messages_for_scheduling(
	work_order_scheduling: str,
	bypass_doc=None,
	used_bypass_names: set[str] | None = None,
):
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
		row_messages = validate_quality_gate_for_row(
			doc,
			row,
			item_group=item_group_map.get(row.item_code),
			rules_by_node=rules_by_node,
			checks_by_row_node=checks_by_row_node,
		)
		if row_messages and bypass_doc and not has_rejected_quality_blocker_for_row(row.name):
			bypass_names = get_quality_gate_bypass_names_for_row(bypass_doc, doc, row)
			if bypass_names:
				if used_bypass_names is not None:
					used_bypass_names.update(bypass_names)
				continue
		messages.extend(row_messages)

	return messages


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
		required_count = get_required_check_count(rule, node, scheduling_row=row)
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

	work_order_schedulings = get_stock_entry_work_order_schedulings(doc)
	if not work_order_schedulings:
		return

	messages = []
	used_bypass_names = set()
	for work_order_scheduling in work_order_schedulings:
		scheduling_messages = _get_quality_gate_messages_for_scheduling(
			work_order_scheduling,
			bypass_doc=doc,
			used_bypass_names=used_bypass_names,
		)
		if not scheduling_messages:
			continue
		messages.extend(scheduling_messages)

	for name in used_bypass_names:
		frappe.db.set_value("Quality Gate Bypass", name, "status", "Used", update_modified=True)

	if not messages:
		return
	frappe.throw("<br>".join(messages), title=_("Quality Gate Not Passed"))


def get_stock_entry_work_order_schedulings(doc) -> list[str]:
	schedules = []
	for fieldname in ("work_order_scheduling", "custom_work_order_scheduling"):
		value = doc.get(fieldname)
		if value:
			schedules.append(value)

	work_orders = []
	if doc.get("work_order"):
		work_orders.append(doc.work_order)
	for row in doc.get("items", []):
		if row.get("work_order"):
			work_orders.append(row.work_order)

	work_orders = list(dict.fromkeys(filter(None, work_orders)))
	if work_orders:
		work_order_meta = frappe.get_meta("Work Order")
		for fieldname in ("work_order_scheduling", "custom_work_order_scheduling"):
			if work_order_meta.has_field(fieldname):
				schedules.extend(
					frappe.get_all(
						"Work Order",
						filters={"name": ("in", work_orders)},
						pluck=fieldname,
					)
				)
		if frappe.db.exists("DocType", "Scheduling Item"):
			schedules.extend(
				frappe.get_all(
					"Scheduling Item",
					filters={"work_order": ("in", work_orders)},
					pluck="parent",
					limit_page_length=100,
				)
			)

	return list(dict.fromkeys(filter(None, schedules)))


def has_rejected_quality_blocker(work_order_scheduling: str) -> bool:
	rows = frappe.get_all("Scheduling Item", filters={"parent": work_order_scheduling}, pluck="name")
	if not rows:
		return False
	return any(has_rejected_quality_blocker_for_row(row_name) for row_name in rows)


def has_rejected_quality_blocker_for_row(scheduling_item: str) -> bool:
	return bool(
		frappe.db.exists(
			"Production Quality Check",
			{
				"scheduling_item": scheduling_item,
				"docstatus": 1,
				"overall_status": "Rejected",
			},
		)
	)


def has_approved_quality_gate_bypass(doc, work_order_scheduling: str | None = None) -> bool:
	if not frappe.db.exists("DocType", "Quality Gate Bypass"):
		return False
	if frappe.db.exists(
		"Quality Gate Bypass",
		{
			"status": "Approved",
			"reference_doctype": "Stock Entry",
			"reference_name": doc.name,
			"company": doc.get("company"),
		},
	):
		return True
	if not work_order_scheduling:
		return False
	scheduling = get_scheduling_doc(work_order_scheduling)
	return any(get_quality_gate_bypass_names_for_row(doc, scheduling, row) for row in scheduling.get("scheduling_items", []))


def mark_quality_gate_bypass_used(doc, work_order_scheduling: str | None = None):
	if not frappe.db.exists("DocType", "Quality Gate Bypass"):
		return
	names = set()
	names.update(
		frappe.get_all(
			"Quality Gate Bypass",
			filters={
				"status": "Approved",
				"reference_doctype": "Stock Entry",
				"reference_name": doc.name,
			},
			pluck="name",
		)
	)
	if work_order_scheduling:
		scheduling = get_scheduling_doc(work_order_scheduling)
		for row in scheduling.get("scheduling_items", []):
			names.update(get_quality_gate_bypass_names_for_row(doc, scheduling, row))
	for name in names:
		frappe.db.set_value("Quality Gate Bypass", name, "status", "Used", update_modified=True)


def get_quality_gate_bypass_names_for_row(stock_entry, scheduling_doc, row) -> list[str]:
	if not frappe.db.exists("DocType", "Quality Gate Bypass"):
		return []
	company = stock_entry.get("company")
	names = set(
		frappe.get_all(
			"Quality Gate Bypass",
			filters={
				"status": "Approved",
				"reference_doctype": "Stock Entry",
				"reference_name": stock_entry.name,
				"company": company,
			},
			pluck="name",
		)
	)
	if not stock_entry_contains_item(stock_entry, row.get("item_code")):
		return sorted(names)

	candidates = frappe.get_all(
		"Quality Gate Bypass",
		filters={"status": "Approved", "company": company},
		fields=[
			"name",
			"reference_doctype",
			"reference_name",
			"work_order_scheduling",
			"scheduling_item",
			"item_code",
			"qty",
		],
		limit_page_length=100,
	)
	for bypass in candidates:
		references_schedule = bypass.work_order_scheduling == scheduling_doc.name or (
			bypass.reference_doctype == "Work Order Scheduling" and bypass.reference_name == scheduling_doc.name
		)
		if not references_schedule:
			continue
		if bypass.scheduling_item and bypass.scheduling_item == row.name:
			names.add(bypass.name)
			continue
		if bypass.item_code and bypass.item_code == row.get("item_code") and flt(bypass.qty) > 0:
			names.add(bypass.name)
	return sorted(names)


def stock_entry_contains_item(stock_entry, item_code: str | None) -> bool:
	if not item_code:
		return False
	return any(row.get("item_code") == item_code for row in stock_entry.get("items", []))


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

	required_count = get_required_check_count(rule, "Patrol", scheduling_row=row)
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
	scheduling_item_fields = [
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
	]
	scheduling_item_meta = frappe.get_meta("Scheduling Item")
	for fieldname in (
		"jce_quality_alert_open",
		"jce_quality_alert_source_check",
		"jce_quality_alert_note",
		"jce_quality_extra_patrol_count",
		"jce_quality_extra_patrol_source_check",
	):
		if scheduling_item_meta.has_field(fieldname):
			scheduling_item_fields.append(fieldname)

	rows = frappe.get_all(
		"Scheduling Item",
		filters={"parent": ("in", schedule_names)},
		fields=scheduling_item_fields,
		order_by="parent asc, idx asc",
	)
	summaries = get_scheduling_items_quality_summary([row.name for row in rows])
	latest_patrol_map = get_latest_accepted_patrol_map([row.name for row in rows])
	item_group_map = get_item_group_map([row.item_code for row in rows])
	item_customer_code_map = get_item_customer_code_map([row.item_code for row in rows])
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
				"quality_alert_open": cint(row.get("jce_quality_alert_open")),
				"quality_alert_source_check": row.get("jce_quality_alert_source_check"),
				"quality_alert_note": row.get("jce_quality_alert_note"),
				"extra_patrol_count": cint(row.get("jce_quality_extra_patrol_count")),
				"extra_patrol_source_check": row.get("jce_quality_extra_patrol_source_check"),
				"customer_code": item_customer_code_map.get(row.item_code),
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
	if doc.docstatus != 1:
		frappe.throw(_("Disposition can only be recorded after the quality check is submitted."))
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
	if doc.docstatus != 1:
		frappe.throw(_("Concession release can only be approved after the quality check is submitted."))
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
		limit_page_length=1001,
	)
	checks_truncated = len(checks) > 1000
	if checks_truncated:
		checks = checks[:1000]
	check_names = [row.name for row in checks]
	defects = []
	if check_names:
		defects = frappe.get_all(
			"Production Quality Defect",
			filters={"parenttype": "Production Quality Check", "parent": ("in", check_names)},
			fields=["parent", "defect_code", "defect_name", "category", "severity", "quantity", "remarks"],
			order_by="idx asc",
			limit_page_length=5001,
		)
	defects_truncated = len(defects) > 5000
	if defects_truncated:
		defects = defects[:5000]

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
		"truncated": {"checks": checks_truncated, "defects": defects_truncated},
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
