from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from contextlib import contextmanager
from urllib.parse import urlencode

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, flt, get_datetime, getdate, now_datetime, today

from erpnext.stock.doctype.quality_inspection.quality_inspection import parse_float
from erpnext.stock.doctype.quality_inspection_template.quality_inspection_template import (
	get_template_details,
)

from jce_quality.services.permissions import has_quality_gate_direct_override_access
from jce_quality.services.template_baseline import apply_template_to_check


QUALITY_NODES = ("First Article", "Patrol", "Last Article", "Final Release")
SHIPPING_QUALITY_NODE = "OQC"
ALL_QUALITY_NODES = (*QUALITY_NODES, SHIPPING_QUALITY_NODE)
PRODUCTION_SOURCE_TYPE = "Production Scheduling"
MANUAL_PRODUCTION_SOURCE_TYPE = "Manual Production"
DELIVERY_NOTE_OQC_SOURCE_TYPE = "Delivery Note OQC"
READING_TEMPLATE_METADATA_FIELDS = ("inspection_method", "inspection_standard")
PASSING_STATUSES = ("Accepted", "Concession Released")
TEMPORARY_CONTINUE_DISPOSITION = "Temporary Continue"
DISPOSITION_OPTIONS = (
	TEMPORARY_CONTINUE_DISPOSITION,
	"Stop Production",
	"Rework",
	"Scrap",
	"Concession Release",
)
SCHEDULING_ITEM_STATUS_FIELDS = {
	"First Article": "jce_quality_first_article_status",
	"Last Article": "jce_quality_last_article_status",
	"Final Release": "jce_quality_final_release_status",
}
FIRST_ARTICLE_FLAG_FIELDS = (
	"custom_is_first_article",
	"jce_quality_is_first_article",
	"first_article_required",
	"is_first_article",
)
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

	doc.source_type = doc.get("source_type") or PRODUCTION_SOURCE_TYPE
	doc.source_doctype = "Work Order Scheduling"
	doc.source_name = scheduling.name
	doc.source_detail = row.name
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


def populate_manual_check_defaults(doc):
	if doc.get("source_type") not in (MANUAL_PRODUCTION_SOURCE_TYPE, DELIVERY_NOTE_OQC_SOURCE_TYPE):
		return

	if not doc.get("posting_date"):
		doc.posting_date = today()
	if doc.get("item_code"):
		item = frappe.db.get_value("Item", doc.item_code, ["item_name", "item_group", "stock_uom"], as_dict=True)
		if item:
			doc.item_name = item.item_name
			doc.item_group = item.item_group
			if not doc.get("uom") and doc.meta.has_field("uom"):
				doc.uom = item.stock_uom
	if doc.get("manual_qty") and not flt(doc.get("scheduling_qty")):
		doc.scheduling_qty = flt(doc.manual_qty)
		doc.completed_qty = flt(doc.manual_qty)
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
	if not rule or not cint(rule_get(rule, "is_mandatory")):
		return 0

	if node == "First Article" and not is_first_article_required_for_row(scheduling_row):
		return 0

	if node == "Patrol":
		required_count = cint(rule_get(rule, "minimum_patrol_count")) if rule else 1
		required_count = required_count if required_count > 0 else 1
		return required_count + get_extra_patrol_count(scheduling_row)

	return 1


def get_required_quality_nodes(requirements: dict | None) -> list[str]:
	requirements = requirements or {}
	return [node for node in QUALITY_NODES if cint(requirements.get(node))]


def is_first_article_required_for_row(scheduling_row=None) -> bool:
	if not scheduling_row:
		return False
	return bool(cint(get_first_article_flag_value(scheduling_row)))


def get_first_article_flag_value(scheduling_row=None):
	if not scheduling_row:
		return 0
	for fieldname in FIRST_ARTICLE_FLAG_FIELDS:
		if hasattr(scheduling_row, "get"):
			value = scheduling_row.get(fieldname)
		else:
			value = getattr(scheduling_row, fieldname, None)
		if value is not None:
			return value
	return 0


def rule_get(rule, fieldname, default=None):
	if not rule:
		return default
	if hasattr(rule, "get"):
		return rule.get(fieldname, default)
	return getattr(rule, fieldname, default)


def get_extra_patrol_count(scheduling_row=None) -> int:
	if not scheduling_row:
		return 0
	return max(cint(getattr(scheduling_row, "jce_quality_extra_patrol_count", 0)), 0)


def summary_meets_requirements(summary: dict, requirements: dict) -> bool:
	if summary.get("frozen"):
		return False
	if summary.get("active_ng_checks"):
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


def make_quality_checks(
	work_order_scheduling: str,
	scheduling_item: str | None = None,
	nodes: list[str] | None = None,
	limit_per_node: int | None = None,
):
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
				if limit_per_node is not None:
					missing_count = min(missing_count, max(cint(limit_per_node), 0))
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

	existing_checks = frappe.get_all(
		"Production Quality Check",
		filters={
			"work_order_scheduling": scheduling_doc.name,
			"scheduling_item": scheduling_row.name,
			"quality_node": node,
			"docstatus": ("<", 2),
		},
		fields=["docstatus", "overall_status"],
	)
	existing = sum(
		1
		for check in existing_checks
		if cint(check.docstatus) == 0 or (cint(check.docstatus) == 1 and check.overall_status in PASSING_STATUSES)
	)
	return max(required_count - existing, 0)


def get_patrol_required_count_for_check(doc) -> int:
	if not doc.get("work_order_scheduling") or not doc.get("scheduling_item"):
		return 0
	scheduling_doc = get_scheduling_doc(doc.work_order_scheduling)
	scheduling_row = get_scheduling_item(doc.scheduling_item)
	item_group = frappe.db.get_value("Item", scheduling_row.item_code, "item_group") if scheduling_row.item_code else None
	rule = get_applicable_rule(
		company=scheduling_doc.company,
		plant_floor=scheduling_doc.plant_floor,
		workstation=scheduling_row.workstation,
		item_code=scheduling_row.item_code,
		item_group=item_group,
		quality_node="Patrol",
	)
	return get_required_check_count(rule, "Patrol", scheduling_row=scheduling_row)


def get_patrol_history_context(doc) -> dict:
	if doc.get("quality_node") != "Patrol" or not (doc.get("work_order_scheduling") and doc.get("scheduling_item")):
		return {"patrol_history": [], "patrol_sequence_no": 0, "patrol_required_count": 0}

	history = frappe.get_all(
		"Production Quality Check",
		filters={
			"work_order_scheduling": doc.work_order_scheduling,
			"scheduling_item": doc.scheduling_item,
			"quality_node": "Patrol",
			"docstatus": ("<", 2),
		},
		fields=[
			"name",
			"docstatus",
			"status",
			"overall_status",
			"system_overall_status",
			"disposition",
			"release_approved",
			"inspection_started_at",
			"inspection_finished_at",
			"inspected_by",
			"defect_sample_qty",
			"defect_rate",
			"inspection_sample_qty",
			"creation",
			"modified",
		],
		order_by="creation asc, name asc",
	)
	current_sequence = 0
	for index, row in enumerate(history, start=1):
		row["sequence_no"] = index
		row["disposition_state"] = get_ng_disposition_state(row)
		row["production_blocking"] = is_production_blocking_ng(row)
		if row.name == doc.name:
			current_sequence = index

	return {
		"patrol_history": history,
		"patrol_sequence_no": current_sequence,
		"patrol_required_count": get_patrol_required_count_for_check(doc),
		"patrol_accepted_count": len(
			[
				row
				for row in history
				if cint(row.get("docstatus")) == 1 and row.get("overall_status") in PASSING_STATUSES
			]
		),
	}


def is_production_blocking_ng(check) -> bool:
	return (
		cint(check.get("docstatus")) == 1
		and check.get("overall_status") == "Rejected"
		and check.get("disposition") != TEMPORARY_CONTINUE_DISPOSITION
	)


def is_temporary_continue_ng(check) -> bool:
	return (
		cint(check.get("docstatus")) == 1
		and check.get("overall_status") == "Rejected"
		and check.get("disposition") == TEMPORARY_CONTINUE_DISPOSITION
	)


def get_ng_disposition_state(check) -> str:
	if check.get("overall_status") == "Concession Released":
		return "Concession Released"
	if check.get("disposition") == TEMPORARY_CONTINUE_DISPOSITION:
		return "Temporary Continue"
	if check.get("disposition") == "Concession Release":
		return "Pending Concession Approval"
	if check.get("disposition") in ("Stop Production", "Rework", "Scrap"):
		return check.get("disposition")
	if check.get("overall_status") == "Rejected":
		return "Pending Disposition"
	return check.get("overall_status") or "Pending"


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
		fields=[
			"name",
			"scheduling_item",
			"quality_node",
			"overall_status",
			"status",
			"docstatus",
			"disposition",
			"disposition_remarks",
			"disposition_by",
			"disposition_at",
			"release_approved",
			"release_approved_by",
			"release_approved_at",
			"modified",
		],
		order_by="scheduling_item asc, modified desc",
	)

	for check in checks:
		summary = summaries.setdefault(check.scheduling_item, _empty_quality_summary())
		if not summary["latest_check"]:
			summary["latest_check"] = check.name
		if check.docstatus == 1 and check.overall_status == "Rejected":
			ng_entry = {
				"name": check.name,
				"quality_node": check.quality_node,
				"disposition": check.disposition,
				"disposition_state": get_ng_disposition_state(check),
				"disposition_remarks": check.disposition_remarks,
				"disposition_by": check.disposition_by,
				"disposition_at": check.disposition_at,
				"release_approved": cint(check.release_approved),
				"release_approved_by": check.release_approved_by,
				"release_approved_at": check.release_approved_at,
				"production_blocking": is_production_blocking_ng(check),
				"modified": check.modified,
			}
			summary["active_ng_checks"].append(ng_entry)
			if is_production_blocking_ng(check):
				summary["frozen"] = True
			if is_production_blocking_ng(check):
				summary["_rejected_by_node"][check.quality_node] = "Rejected"
			elif check.quality_node not in summary["_rejected_by_node"]:
				summary["_rejected_by_node"][check.quality_node] = TEMPORARY_CONTINUE_DISPOSITION
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
		"active_ng_checks": [],
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


def validate_quality_gate_for_scheduling(work_order_scheduling: str, allow_direct_override: bool = False) -> bool:
	messages = get_quality_gate_messages_for_scheduling(work_order_scheduling)
	if not messages:
		return False

	if allow_direct_override and has_quality_gate_direct_override_access():
		warn_quality_gate_direct_override(messages)
		return True

	frappe.throw("<br>".join(messages), title=_("Quality Gate Not Passed"))


def get_quality_gate_messages_for_scheduling(work_order_scheduling: str):
	return _get_quality_gate_messages_for_scheduling(work_order_scheduling)


def warn_quality_gate_direct_override(messages: list[str]):
	preview = list(messages or [])[:5]
	remaining = max(len(messages or []) - len(preview), 0)
	detail = "<br>".join(preview)
	if remaining:
		detail = f"{detail}<br>{_('And {0} more quality gate issue(s).').format(remaining)}"

	message = _(
		"Quality gate is not passed. This operation is allowed because your role is configured for direct quality gate override."
	)
	if detail:
		message = f"{message}<br><br>{detail}"

	frappe.msgprint(message, title=_("Quality Gate Override Warning"), indicator="orange")


def _get_quality_gate_messages_for_scheduling(
	work_order_scheduling: str,
	bypass_doc=None,
	used_bypass_names: set[str] | None = None,
	bypass_context: dict | None = None,
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
			bypass_names = get_quality_gate_bypass_names_for_row(bypass_doc, doc, row, bypass_context=bypass_context)
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
	bypass_context = get_quality_gate_bypass_context(doc)
	for work_order_scheduling in work_order_schedulings:
		scheduling_messages = _get_quality_gate_messages_for_scheduling(
			work_order_scheduling,
			bypass_doc=doc,
			used_bypass_names=used_bypass_names,
			bypass_context=bypass_context,
		)
		if not scheduling_messages:
			continue
		messages.extend(scheduling_messages)

	for name in used_bypass_names:
		frappe.db.set_value("Quality Gate Bypass", name, "status", "Used", update_modified=True)

	if not messages:
		return
	if has_quality_gate_direct_override_access():
		warn_quality_gate_direct_override(messages)
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


def get_quality_gate_bypass_context(stock_entry) -> dict:
	if not frappe.db.exists("DocType", "Quality Gate Bypass"):
		return {}
	company = stock_entry.get("company")
	stock_entry_names = set(
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
		limit_page_length=500,
	)
	return {"stock_entry_names": stock_entry_names, "candidates_by_company": {company: candidates}}


def get_quality_gate_bypass_names_for_row(stock_entry, scheduling_doc, row, bypass_context: dict | None = None) -> list[str]:
	if not frappe.db.exists("DocType", "Quality Gate Bypass"):
		return []
	company = stock_entry.get("company")
	if bypass_context is not None:
		names = set(bypass_context.get("stock_entry_names") or [])
	else:
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

	candidates = None
	if bypass_context is not None:
		candidates = (bypass_context.get("candidates_by_company") or {}).get(company)
	if candidates is None:
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
		*FIRST_ARTICLE_FLAG_FIELDS,
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
		required_nodes = get_required_quality_nodes(requirements)
		if not required_nodes:
			continue
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
				"is_first_article": cint(get_first_article_flag_value(row)),
				"quality_requirements": requirements,
				"required_quality_nodes": required_nodes,
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

	tasks.sort(
		key=lambda task: (
			-1 if cint(task.get("first_article_required")) else 0,
			get_datetime(task.get("from_time")) if task.get("from_time") else get_datetime(f"{task.get('posting_date')} 00:00:00"),
			task.get("workstation") or "",
			cint(task.get("idx")),
			task.get("name") or "",
		)
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


def create_manual_production_check(
	item_code: str,
	workstation: str,
	quality_node: str = "Patrol",
	company: str | None = None,
	plant_floor: str | None = None,
	shift_type: str | None = None,
	posting_date: str | None = None,
	qty: float | None = None,
	remarks: str | None = None,
) -> str:
	if quality_node not in QUALITY_NODES:
		frappe.throw(_("Manual production checks can only use production quality nodes."))
	if not item_code or not workstation:
		frappe.throw(_("Item Code and Workstation are required for manual production check."))
	manual_qty = flt(qty)
	if manual_qty <= 0:
		frappe.throw(_("Manual production check quantity must be greater than zero."))

	doc = frappe.new_doc("Production Quality Check")
	doc.source_type = MANUAL_PRODUCTION_SOURCE_TYPE
	doc.quality_node = quality_node
	doc.company = company
	doc.plant_floor = plant_floor
	doc.shift_type = shift_type
	doc.posting_date = posting_date or today()
	doc.workstation = workstation
	doc.item_code = item_code
	doc.manual_qty = manual_qty
	doc.scheduling_qty = manual_qty
	doc.completed_qty = manual_qty
	doc.remarks = remarks
	populate_manual_check_defaults(doc)
	ensure_check_node_is_required(doc)
	load_template_readings(doc)
	doc.check_permission("create")
	doc.insert(ignore_permissions=True)
	return doc.name


def get_manual_production_quality_node_options(
	item_code: str | None = None,
	workstation: str | None = None,
	company: str | None = None,
	plant_floor: str | None = None,
) -> list[dict]:
	if not item_code or not workstation:
		return []
	item_group = frappe.db.get_value("Item", item_code, "item_group") if item_code else None
	options = []
	for node in QUALITY_NODES:
		if node == "First Article":
			continue
		rule = get_applicable_rule(
			company=company,
			plant_floor=plant_floor,
			workstation=workstation,
			item_code=item_code,
			item_group=item_group,
			quality_node=node,
		)
		required_count = get_required_check_count(rule, node)
		if not required_count:
			continue
		options.append(
			{
				"value": node,
				"label": _(node),
				"required_count": required_count,
				"production_quality_rule": rule.name if rule else None,
				"quality_inspection_template": rule.quality_inspection_template if rule else None,
			}
		)
	return options


def get_scheduling_quality_node_requirement(work_order_scheduling: str, scheduling_item: str, quality_node: str) -> dict:
	if quality_node not in QUALITY_NODES:
		frappe.throw(_("Invalid production quality node {0}.").format(quality_node))
	scheduling_doc = get_scheduling_doc(work_order_scheduling)
	scheduling_row = get_scheduling_item(scheduling_item)
	if scheduling_row.parent != scheduling_doc.name:
		frappe.throw(_("Scheduling Item {0} does not belong to Work Order Scheduling {1}.").format(scheduling_row.name, scheduling_doc.name))
	item_group = frappe.db.get_value("Item", scheduling_row.item_code, "item_group") if scheduling_row.item_code else None
	rule = get_applicable_rule(
		company=scheduling_doc.company,
		plant_floor=scheduling_doc.plant_floor,
		workstation=scheduling_row.workstation,
		item_code=scheduling_row.item_code,
		item_group=item_group,
		quality_node=quality_node,
	)
	required_count = get_required_check_count(rule, quality_node, scheduling_row=scheduling_row)
	return {
		"quality_node": quality_node,
		"required_count": required_count,
		"is_required": bool(required_count),
		"production_quality_rule": rule.name if rule else None,
		"is_mandatory": cint(rule_get(rule, "is_mandatory")) if rule else 0,
		"is_first_article": is_first_article_required_for_row(scheduling_row),
	}


def ensure_check_node_is_required(doc):
	rule = get_applicable_rule(
		company=doc.get("company"),
		plant_floor=doc.get("plant_floor"),
		workstation=doc.get("workstation"),
		item_code=doc.get("item_code"),
		item_group=doc.get("item_group"),
		quality_node=doc.get("quality_node"),
	)
	if not get_required_check_count(rule, doc.get("quality_node")):
		frappe.throw(_("{0} is not configured as a mandatory production gate, so no inspection task is required.").format(_(doc.quality_node)))


def get_delivery_oqc_items(delivery_note: str):
	dn = get_delivery_note_doc(delivery_note, require_submitted=True, allow_return=False)
	groups = build_delivery_oqc_groups(dn)
	existing = get_delivery_oqc_checks_map(dn.name)
	item_group_map = get_item_group_map([group.get("item_code") for group in groups.values()])
	oqc_rules = get_enabled_quality_rules(SHIPPING_QUALITY_NODE)
	rows = []
	for key, group in groups.items():
		check = existing.get(key)
		rule = get_applicable_rule(
			company=dn.company,
			plant_floor=None,
			workstation=None,
			item_code=group.get("item_code"),
			item_group=item_group_map.get(group.get("item_code")),
			quality_node=SHIPPING_QUALITY_NODE,
			rules=oqc_rules,
		)
		rows.append(
			{
				**group,
				"delivery_note": dn.name,
				"source_detail": key,
				"check_name": check.name if check else None,
				"overall_status": check.overall_status if check else "Pending",
				"release_status": check.get("release_status") if check else "Pending",
				"docstatus": check.docstatus if check else 0,
				"production_quality_rule": rule.name if rule else None,
				"quality_inspection_template": rule.quality_inspection_template if rule else None,
				"oqc_rule_mandatory": cint(rule.is_mandatory) if rule else 0,
				"manual_allowed": 1,
			}
		)
	return rows


def get_delivery_oqc_delivery_notes(
	from_date: str | None = None,
	to_date: str | None = None,
	customer: str | None = None,
	delivery_note: str | None = None,
	delivery_plan: str | None = None,
	limit: int = 100,
) -> list[dict]:
	if not frappe.db.exists("DocType", "Delivery Note"):
		return []

	dn_meta = frappe.get_meta("Delivery Note")
	filters = {"docstatus": 1}
	if dn_meta.has_field("is_return"):
		filters["is_return"] = 0
	if delivery_note:
		filters["name"] = delivery_note
	if customer:
		filters["customer"] = customer
	if delivery_plan:
		if not dn_meta.has_field("delivery_plan"):
			return []
		filters["delivery_plan"] = delivery_plan
	if from_date and to_date:
		filters["posting_date"] = ("between", [getdate(from_date), getdate(to_date)])
	elif from_date:
		filters["posting_date"] = (">=", getdate(from_date))
	elif to_date:
		filters["posting_date"] = ("<=", getdate(to_date))

	fields = ["name", "posting_date", "customer", "company", "status", "docstatus"]
	for fieldname in ("delivery_plan", "grand_total", "currency"):
		if dn_meta.has_field(fieldname):
			fields.append(fieldname)

	return frappe.get_list(
		"Delivery Note",
		filters=filters,
		fields=fields,
		order_by="posting_date desc, modified desc",
		limit_page_length=cint(limit) or 100,
	)


def get_delivery_plan_delivery_notes(delivery_plan: str) -> list[dict]:
	if not delivery_plan:
		frappe.throw(_("Delivery Plan is required."))
	if not frappe.db.exists("DocType", "Delivery Plan"):
		frappe.throw(_("Delivery Plan is not available on this site."))
	if not frappe.db.exists("Delivery Plan", delivery_plan):
		frappe.throw(_("Delivery Plan {0} does not exist.").format(delivery_plan))
	dn_meta = frappe.get_meta("Delivery Note")
	if not dn_meta.has_field("delivery_plan"):
		return []
	filters = {"delivery_plan": delivery_plan, "docstatus": 1}
	if dn_meta.has_field("is_return"):
		filters["is_return"] = 0
	return frappe.get_list(
		"Delivery Note",
		filters=filters,
		fields=["name", "posting_date", "customer", "company", "status", "docstatus"],
		order_by="posting_date desc, modified desc",
		limit_page_length=50,
	)


def get_or_create_delivery_oqc_check(
	delivery_note: str,
	item_code: str,
	warehouse: str | None = None,
	uom: str | None = None,
) -> str:
	dn = get_delivery_note_doc(delivery_note, require_submitted=True, allow_return=False)
	groups = build_delivery_oqc_groups(dn)
	key = make_delivery_oqc_group_key(item_code, warehouse, uom)
	group = groups.get(key)
	if not group:
		frappe.throw(_("No Delivery Note item found for {0}.").format(item_code))

	existing = get_delivery_oqc_checks_map(dn.name).get(key)
	if existing:
		return existing.name

	doc = frappe.new_doc("Production Quality Check")
	doc.source_type = DELIVERY_NOTE_OQC_SOURCE_TYPE
	doc.source_doctype = "Delivery Note"
	doc.source_name = dn.name
	doc.source_detail = key
	doc.source_group_key = dn.name
	doc.source_rows = json.dumps(group.get("source_rows") or [], default=str)
	doc.quality_node = SHIPPING_QUALITY_NODE
	doc.company = dn.company
	doc.customer = dn.get("customer") if doc.meta.has_field("customer") else None
	doc.posting_date = dn.get("posting_date") or today()
	doc.item_code = group.get("item_code")
	doc.item_name = group.get("item_name")
	doc.uom = group.get("uom")
	doc.workstation = None
	doc.scheduling_qty = group.get("qty")
	doc.completed_qty = group.get("qty")
	doc.manual_qty = group.get("qty")
	populate_manual_check_defaults(doc)
	load_template_readings(doc)
	doc.check_permission("create")
	doc.insert(ignore_permissions=True)
	return doc.name


def release_oqc_check(
	check_name: str,
	release_status: str = "Released",
	temporary_release_note: str | None = None,
	escalate_to_dmr: bool = False,
) -> dict:
	doc = frappe.get_doc("Production Quality Check", check_name)
	validate_oqc_release_request(doc, release_status, temporary_release_note, escalate_to_dmr)
	doc.db_set("release_status", release_status, update_modified=False)
	if temporary_release_note is not None:
		doc.db_set("temporary_release_note", temporary_release_note.strip(), update_modified=False)
	dmr_name = doc.get("escalated_dmr")
	if escalate_to_dmr and not dmr_name:
		if doc.docstatus != 1 or doc.overall_status != "Rejected":
			frappe.throw(_("Submit a rejected OQC check before escalating to DMR."))
		from jce_quality.services.dmr import make_dmr_from_source

		dmr_name = make_dmr_from_source("Production Quality Check", doc.name, dmr_type="OQC")
		doc.db_set("escalated_dmr", dmr_name, update_modified=False)
		if doc.meta.has_field("dmr"):
			doc.db_set("dmr", dmr_name, update_modified=False)
	return {"check_name": doc.name, "release_status": release_status, "dmr": dmr_name}


def validate_oqc_release_request(
	doc,
	release_status: str = "Released",
	temporary_release_note: str | None = None,
	escalate_to_dmr: bool = False,
) -> None:
	if doc.get("source_type") != DELIVERY_NOTE_OQC_SOURCE_TYPE:
		frappe.throw(_("Only Delivery Note OQC checks can be released here."))
	if release_status not in ("Pending", "Released", "Temporary Released", "Blocked"):
		frappe.throw(_("Invalid OQC release status {0}.").format(release_status))
	if doc.docstatus != 1:
		frappe.throw(_("Submit the OQC check before changing release status."))

	if release_status in ("Released", "Temporary Released"):
		if doc.overall_status not in PASSING_STATUSES:
			frappe.throw(_("Only accepted or concession released OQC checks can be released."))
		if release_status == "Temporary Released" and not (temporary_release_note or "").strip():
			frappe.throw(_("Temporary Release Note is required for temporary release."))

	if release_status == "Blocked" and doc.overall_status != "Rejected":
		frappe.throw(_("Only rejected OQC checks can be blocked."))

	if escalate_to_dmr and doc.overall_status != "Rejected":
		frappe.throw(_("Only rejected OQC checks can be escalated to DMR."))


def get_oqc_email_package(
	delivery_note: str,
	include_print_urls: bool = True,
	ignore_check_permissions: bool = False,
) -> dict:
	dn = get_delivery_note_doc(delivery_note, require_submitted=True, allow_return=False)
	expected_groups = build_delivery_oqc_groups(dn)
	get_checks = frappe.get_all if ignore_check_permissions else frappe.get_list
	checks = get_checks(
		"Production Quality Check",
		filters={
			"source_type": DELIVERY_NOTE_OQC_SOURCE_TYPE,
			"source_doctype": "Delivery Note",
			"source_name": dn.name,
			"docstatus": ("<", 2),
		},
		fields=[
			"name",
			"item_code",
			"item_name",
			"uom",
			"scheduling_qty",
			"source_detail",
			"docstatus",
			"overall_status",
			"release_status",
			"quality_node",
			"modified",
		],
		order_by="item_code asc, name asc",
	)
	print_format = get_quality_print_format("OQC", "Production Quality Check")
	rows = []
	for check in checks:
		item = dict(check)
		item["ready"] = is_oqc_check_ready_for_email(check)
		item["print_format"] = print_format
		cached_file = get_cached_oqc_pdf_file(check.name, check.modified, print_format)
		item["cached_pdf"] = cached_file
		if include_print_urls:
			item["print_url"] = get_print_url("Production Quality Check", check.name, print_format)
		rows.append(item)
	ready_keys = {
		row.get("source_detail")
		for row in rows
		if row.get("source_detail") and row.get("ready")
	}
	missing_groups = [
		{**group, "source_detail": key}
		for key, group in expected_groups.items()
		if key not in ready_keys
	]
	ready = bool(expected_groups) and not missing_groups
	return {
		"delivery_note": dn.name,
		"customer": dn.get("customer"),
		"company": dn.get("company"),
		"posting_date": dn.get("posting_date"),
		"delivery_group_key": dn.name,
		"print_format": print_format,
		"checks": rows,
		"missing_items": missing_groups,
		"ready": ready,
		"send_allowed": ready,
		"manual_confirmation_required": True,
	}


def enqueue_oqc_pdf_cache(delivery_note: str, ignore_check_permissions: bool = False):
	get_delivery_note_doc(delivery_note, require_submitted=True, allow_return=False)
	return frappe.enqueue(
		"jce_quality.services.quality.cache_oqc_pdfs",
		queue="short",
		delivery_note=delivery_note,
		ignore_check_permissions=ignore_check_permissions,
	)


def cache_oqc_pdfs(delivery_note: str, ignore_check_permissions: bool = False):
	package = get_oqc_email_package(
		delivery_note,
		include_print_urls=False,
		ignore_check_permissions=ignore_check_permissions,
	)
	for check in package.get("checks", []):
		if check.get("cached_pdf"):
			continue
		create_cached_oqc_pdf(
			check.get("name"),
			check.get("modified"),
			check.get("print_format"),
			ignore_permissions=ignore_check_permissions,
		)
	return get_oqc_email_package(
		delivery_note,
		include_print_urls=False,
		ignore_check_permissions=ignore_check_permissions,
	)


def is_oqc_check_ready_for_email(check) -> bool:
	return (
		cint(check.get("docstatus")) == 1
		and check.get("overall_status") in PASSING_STATUSES
		and check.get("release_status") == "Released"
	)


def get_cached_oqc_pdf_file(check_name: str, modified=None, print_format: str | None = None) -> str | None:
	file_name = get_cached_oqc_pdf_filename(check_name, modified, print_format)
	return frappe.db.get_value(
		"File",
		{
			"attached_to_doctype": "Production Quality Check",
			"attached_to_name": check_name,
			"file_name": file_name,
			"is_folder": 0,
		},
		"file_url",
	)


def create_cached_oqc_pdf(
	check_name: str,
	modified=None,
	print_format: str | None = None,
	ignore_permissions: bool = False,
) -> str:
	if not check_name:
		return ""
	check_doc = frappe.get_doc("Production Quality Check", check_name)
	if not ignore_permissions:
		check_doc.check_permission("read")
	file_name = get_cached_oqc_pdf_filename(check_name, modified, print_format)
	if existing := get_cached_oqc_pdf_file(check_name, modified, print_format):
		return existing
	previous_ignore_print_permissions = getattr(frappe.local.flags, "ignore_print_permissions", False)
	frappe.local.flags.ignore_print_permissions = True
	try:
		pdf_content = frappe.get_print(
			"Production Quality Check",
			check_name,
			print_format or "Standard",
			as_pdf=True,
		)
	finally:
		frappe.local.flags.ignore_print_permissions = previous_ignore_print_permissions
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": file_name,
			"attached_to_doctype": "Production Quality Check",
			"attached_to_name": check_name,
			"is_private": 1,
			"content": pdf_content,
		}
	)
	file_doc.save(ignore_permissions=True)
	return file_doc.file_url


def get_cached_oqc_pdf_filename(check_name: str, modified=None, print_format: str | None = None) -> str:
	key = hashlib.sha1(f"{check_name}|{modified}|{print_format or 'Standard'}".encode()).hexdigest()[:10]
	return f"OQC-{check_name}-{key}.pdf"


def get_delivery_note_doc(delivery_note: str, require_submitted: bool = False, allow_return: bool = True):
	if not delivery_note:
		frappe.throw(_("Delivery Note is required."))
	if not frappe.db.exists("Delivery Note", delivery_note):
		frappe.throw(_("Delivery Note {0} does not exist.").format(delivery_note))
	dn = frappe.get_doc("Delivery Note", delivery_note)
	if require_submitted and dn.docstatus != 1:
		frappe.throw(_("Delivery Note {0} must be submitted before OQC.").format(delivery_note))
	if not allow_return and cint(dn.get("is_return")):
		frappe.throw(_("Return Delivery Note {0} cannot be used for OQC.").format(delivery_note))
	return dn


def build_delivery_oqc_groups(dn) -> dict[str, dict]:
	groups = {}
	for row in dn.get("items", []):
		if not row.get("item_code"):
			continue
		qty = flt(row.get("qty") or row.get("stock_qty"))
		if qty <= 0:
			continue
		key = make_delivery_oqc_group_key(row.item_code, row.get("warehouse"), row.get("uom") or row.get("stock_uom"))
		group = groups.setdefault(
			key,
			{
				"item_code": row.item_code,
				"item_name": row.get("item_name"),
				"warehouse": row.get("warehouse"),
				"uom": row.get("uom") or row.get("stock_uom"),
				"qty": 0,
				"source_rows": [],
			},
		)
		group["qty"] += qty
		group["source_rows"].append(
			{
				"doctype": row.doctype,
				"name": row.name,
				"idx": row.idx,
				"item_code": row.item_code,
				"warehouse": row.get("warehouse"),
				"uom": row.get("uom") or row.get("stock_uom"),
				"qty": qty,
				"sales_order": row.get("against_sales_order") or row.get("sales_order"),
				"so_detail": row.get("so_detail"),
			}
		)
	return groups


def make_delivery_oqc_group_key(item_code: str, warehouse: str | None = None, uom: str | None = None) -> str:
	return "||".join([item_code or "", warehouse or "", uom or ""])


def get_delivery_oqc_checks_map(delivery_note: str) -> dict[str, frappe._dict]:
	rows = frappe.get_all(
		"Production Quality Check",
		filters={
			"source_type": DELIVERY_NOTE_OQC_SOURCE_TYPE,
			"source_doctype": "Delivery Note",
			"source_name": delivery_note,
			"docstatus": ("<", 2),
		},
		fields=["name", "source_detail", "overall_status", "release_status", "docstatus", "modified"],
		order_by="modified desc",
	)
	result = {}
	for row in rows:
		if row.source_detail and row.source_detail not in result:
			result[row.source_detail] = row
	return result


def get_quality_print_format(inspection_context: str, doctype: str) -> str | None:
	if not frappe.db.exists("DocType", "JCE Quality Settings"):
		return None
	settings_meta = frappe.get_meta("JCE Quality Settings")
	if not settings_meta.has_field("print_format_mappings"):
		return None
	settings = frappe.get_single("JCE Quality Settings")
	for row in settings.get("print_format_mappings", []):
		if not cint(row.get("enabled", 1)):
			continue
		if row.get("inspection_context") == inspection_context and row.get("doctype_name") == doctype:
			return row.get("print_format")
	return None


def get_print_url(doctype: str, name: str, print_format: str | None = None) -> str:
	params = {
		"doctype": doctype,
		"name": name,
		"format": print_format or "Standard",
		"no_letterhead": 0,
	}
	return "/api/method/frappe.utils.print_format.download_pdf?" + urlencode(params)


def mark_disposition(doc, disposition: str, remarks: str | None = None):
	if doc.docstatus != 1:
		frappe.throw(_("Disposition can only be recorded after the quality check is submitted."))
	if doc.overall_status != "Rejected":
		frappe.throw(_("Disposition is only required for rejected checks."))
	if disposition not in DISPOSITION_OPTIONS:
		frappe.throw(_("Invalid disposition {0}.").format(disposition))

	doc.db_set("disposition", disposition, update_modified=False)
	doc.db_set("disposition_remarks", remarks, update_modified=False)
	doc.db_set("disposition_by", frappe.session.user, update_modified=False)
	doc.db_set("disposition_at", now_datetime(), update_modified=True)
	sync_scheduling_item_quality_status(doc.scheduling_item)


def approve_concession_release(doc):
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
		fields=["name", "defect_code", "defect_name", "category", "severity", "description"],
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
