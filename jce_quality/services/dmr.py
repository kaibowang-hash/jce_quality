from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from jce_quality.services.permissions import check_document_permission, require_dmr_stock_transfer_access


DMR_SOURCE_DOCTYPES = ("Quality Inspection", "Production Quality Check", "Delivery Note")
DMR_TYPE_SOURCE_MAP = {
	"IQC": "Quality Inspection",
	"IPQC": "Production Quality Check",
	"OQC": "Production Quality Check",
	"Customer Complaint": "Delivery Note",
}
DMR_STOCK_TRANSFER_STATUSES = ("Pending Disposition", "Return Rejection Completed")


def make_dmr_from_source(
	source_doctype: str,
	source_name: str,
	item_code: str | None = None,
	dmr_type: str | None = None,
) -> str:
	if source_doctype not in DMR_SOURCE_DOCTYPES:
		frappe.throw(_("Unsupported DMR source {0}.").format(source_doctype))
	if not frappe.db.exists(source_doctype, source_name):
		frappe.throw(_("{0} {1} does not exist.").format(source_doctype, source_name))

	source = frappe.get_doc(source_doctype, source_name)
	check_document_permission(source, "read")
	validate_dmr_source(source, item_code=item_code, dmr_type=dmr_type)
	dmr = frappe.new_doc("DMR")
	dmr.naming_series = "DMR-.YY.-"
	dmr.source_doctype = source_doctype
	dmr.source_name = source_name
	populate_dmr_from_source(dmr, source, item_code=item_code, dmr_type=dmr_type)
	existing = get_existing_dmr(dmr.source_doctype, dmr.source_name, dmr.item_code)
	if existing:
		write_back_dmr_reference(source, existing)
		return existing
	dmr.insert(ignore_permissions=True)
	write_back_dmr_reference(source, dmr.name)
	return dmr.name


def validate_dmr_source(source, item_code: str | None = None, dmr_type: str | None = None):
	if source.doctype == "Quality Inspection":
		if source.docstatus != 1:
			frappe.throw(_("Quality Inspection {0} must be submitted before creating DMR.").format(source.name))
		if source.get("status") != "Rejected":
			frappe.throw(_("Only rejected Quality Inspection can create IQC DMR."))
		if dmr_type and dmr_type != "IQC":
			frappe.throw(_("Quality Inspection can only create IQC DMR."))
		return

	if source.doctype == "Production Quality Check":
		if source.docstatus != 1:
			frappe.throw(_("Production Quality Check {0} must be submitted before creating DMR.").format(source.name))
		if source.get("overall_status") != "Rejected":
			frappe.throw(_("Only rejected Production Quality Check can create DMR."))
		return

	if source.doctype == "Delivery Note":
		if source.docstatus != 1:
			frappe.throw(_("Delivery Note {0} must be submitted before creating Customer Complaint DMR.").format(source.name))
		if source.get("is_return"):
			frappe.throw(_("Customer Complaint DMR must reference the original Delivery Note, not a return."))
		_pick_child_item(source, item_code, "items")


def populate_dmr_from_source(dmr, source, item_code: str | None = None, dmr_type: str | None = None):
	if source.doctype == "Quality Inspection":
		dmr.dmr_type = dmr_type or "IQC"
		if dmr.dmr_type != "IQC":
			frappe.throw(_("Quality Inspection can only create IQC DMR."))
		dmr.company = _get_reference_field(source.get("reference_type"), source.get("reference_name"), "company")
		dmr.supplier = _get_reference_field(source.get("reference_type"), source.get("reference_name"), "supplier")
		dmr.customer = _get_reference_field(source.get("reference_type"), source.get("reference_name"), "customer")
		dmr.item_code = item_code or source.get("item_code")
		dmr.qty = flt(source.get("sample_size")) or flt(source.get("qty")) or 1
		dmr.uom = source.get("stock_uom") or source.get("uom")
		dmr.source_date = source.get("report_date") or source.get("inspection_date") or nowdate()
		dmr.reference_number = source.get("reference_name")
		dmr.source_detail = source.get("reference_type")
		return

	if source.doctype == "Production Quality Check":
		dmr.dmr_type = get_check_dmr_type(source, dmr_type)
		dmr.company = source.company
		dmr.item_code = source.item_code
		dmr.qty = _get_check_defect_qty(source)
		dmr.source_date = source.posting_date or nowdate()
		dmr.reference_number = source.work_order or source.work_order_scheduling
		dmr.source_detail = source.quality_node
		dmr.defect_description = source.remarks
		if source.get("defects"):
			first_defect = source.defects[0]
			dmr.defect_code = first_defect.defect_code
			dmr.defect_description = dmr.defect_description or first_defect.remarks or first_defect.defect_name
		return

	if source.doctype == "Delivery Note":
		row = _pick_child_item(source, item_code, "items")
		dmr.dmr_type = "Customer Complaint"
		dmr.company = source.company
		dmr.customer = source.customer
		dmr.item_code = row.item_code
		dmr.qty = flt(row.qty)
		dmr.uom = row.uom
		dmr.source_date = source.posting_date
		dmr.reference_number = row.get("against_sales_order") or source.get("po_no")
		dmr.source_detail = row.name
		dmr.original_delivery_note = source.name
		return


def _get_reference_field(reference_type: str | None, reference_name: str | None, fieldname: str):
	if not reference_type or not reference_name or not frappe.db.exists(reference_type, reference_name):
		return None
	if not frappe.get_meta(reference_type).has_field(fieldname):
		return None
	return frappe.db.get_value(reference_type, reference_name, fieldname)


def get_check_dmr_type(check, requested_type: str | None = None) -> str:
	allowed = ("IPQC", "OQC")
	if requested_type:
		if requested_type not in allowed:
			frappe.throw(_("Production Quality Check DMR Type must be IPQC or OQC."))
		return requested_type
	if check.quality_node == "Patrol":
		return "IPQC"
	if check.quality_node == "Final Release":
		return "OQC"
	frappe.throw(_("Please select DMR Type for {0} quality check.").format(check.quality_node))


def get_existing_dmr(source_doctype: str, source_name: str, item_code: str | None) -> str | None:
	if not item_code:
		return None
	return frappe.db.get_value(
		"DMR",
		{
			"source_doctype": source_doctype,
			"source_name": source_name,
			"item_code": item_code,
			"docstatus": ("<", 2),
		},
		"name",
		order_by="modified desc",
	)


def write_back_dmr_reference(source, dmr_name: str):
	if frappe.get_meta(source.doctype).has_field("dmr"):
		if source.get("dmr") != dmr_name:
			frappe.db.set_value(source.doctype, source.name, "dmr", dmr_name, update_modified=False)


def _get_check_defect_qty(check) -> float:
	child_total = sum(flt(row.quantity) for row in check.get("defects", []))
	return child_total or flt(check.defect_qty) or 1


def _pick_child_item(source, item_code: str | None, table_fieldname: str, prefer_rejected: bool = False):
	rows = list(source.get(table_fieldname) or [])
	if item_code:
		rows = [row for row in rows if row.item_code == item_code]
	if not rows:
		frappe.throw(_("No item row found for DMR source {0}.").format(source.name))
	if prefer_rejected:
		for row in rows:
			if flt(row.get("rejected_qty")):
				return row
	return rows[0]


def get_company_quality_warehouses(company: str | None) -> dict:
	settings = frappe.get_single("JCE Quality Settings")
	for row in settings.get("warehouse_settings", []):
		if row.company == company:
			warehouses = {
				"return_inspection_warehouse": row.return_inspection_warehouse,
				"ng_warehouse": row.ng_warehouse,
				"scrap_warehouse": row.scrap_warehouse,
				"finished_goods_warehouse": row.finished_goods_warehouse,
			}
			missing = [key for key, value in warehouses.items() if not value]
			if missing:
				frappe.throw(
					_("Please configure {0} in JCE Quality Settings for company {1}.").format(
						", ".join(missing), company or "-"
					)
				)
			return warehouses
	frappe.throw(_("Please configure JCE Quality Settings warehouses for company {0}.").format(company or "-"))


def make_customer_exchange_stock_entry(dmr_name: str) -> str:
	require_dmr_stock_transfer_access()
	dmr = frappe.get_doc("DMR", dmr_name)
	validate_dmr_stock_transfer_state(dmr)
	if dmr.dmr_type != "Customer Complaint" or dmr.customer_requirement != "Exchange":
		frappe.throw(_("Exchange transfer can only be created for Customer Complaint DMR with Exchange requirement."))
	if dmr.first_exchange_stock_entry:
		return dmr.first_exchange_stock_entry
	warehouses = get_company_quality_warehouses(dmr.company)
	qty = flt(dmr.actual_exchange_qty)
	if qty <= 0:
		frappe.throw(_("Actual Exchange Qty is required."))
	stock_entry = _new_transfer_stock_entry(dmr)
	_add_stock_entry_item(
		stock_entry,
		dmr.item_code,
		qty,
		warehouses["finished_goods_warehouse"],
		warehouses["return_inspection_warehouse"],
	)
	stock_entry.insert(ignore_permissions=True)
	dmr.db_set("first_exchange_stock_entry", stock_entry.name, update_modified=True)
	return stock_entry.name


def make_reinspection_stock_entry(dmr_name: str) -> str:
	require_dmr_stock_transfer_access()
	dmr = frappe.get_doc("DMR", dmr_name)
	validate_dmr_stock_transfer_state(dmr)
	if dmr.dmr_type != "Customer Complaint":
		frappe.throw(_("Reinspection transfer can only be created for Customer Complaint DMR."))
	if dmr.customer_requirement == "Return":
		if flt(dmr.actual_return_qty) <= 0:
			frappe.throw(_("Actual Return Qty is required before reinspection transfer."))
		validate_delivery_note_return(dmr)
	elif dmr.customer_requirement == "Exchange":
		if flt(dmr.actual_exchange_qty) <= 0:
			frappe.throw(_("Actual Exchange Qty is required before reinspection transfer."))
	else:
		frappe.throw(_("Customer Requirement is required before reinspection transfer."))
	if dmr.disposition_stock_entry:
		return dmr.disposition_stock_entry
	if not dmr.get("reinspection_results"):
		frappe.throw(_("Reinspection Results are required."))
	dmr.validate_reinspection_results(require_exact=True)
	get_company_quality_warehouses(dmr.company)
	stock_entry = _new_transfer_stock_entry(dmr)
	for result in dmr.reinspection_results:
		qty = flt(result.qty)
		if qty <= 0:
			continue
		source_warehouse = result.source_warehouse
		target_warehouse = result.target_warehouse
		result_type = result.get("result_type") or result.get("result")
		if not target_warehouse:
			frappe.throw(_("Row {0}: Target Warehouse is required for {1} reinspection result.").format(result.idx, result_type))
		if not source_warehouse:
			frappe.throw(_("Row {0}: Source Warehouse is required for {1} reinspection result.").format(result.idx, result_type))
		_add_stock_entry_item(stock_entry, dmr.item_code, qty, source_warehouse, target_warehouse)
	if not stock_entry.items:
		frappe.throw(_("No positive reinspection quantity found."))
	stock_entry.insert(ignore_permissions=True)
	dmr.flags.ignore_validate_update_after_submit = True
	dmr.disposition_stock_entry = stock_entry.name
	dmr.save(ignore_permissions=True)
	return stock_entry.name


def validate_dmr_stock_transfer_state(dmr):
	if dmr.status not in DMR_STOCK_TRANSFER_STATUSES:
		frappe.throw(
			_("DMR stock transfer can only be created when status is {0}.").format(
				", ".join(_(status) for status in DMR_STOCK_TRANSFER_STATUSES)
			)
		)


def validate_delivery_note_return(dmr):
	if not dmr.delivery_note_return:
		frappe.throw(_("Delivery Note Return is required before creating reinspection transfer for returned goods."))
	if not frappe.db.exists("Delivery Note", dmr.delivery_note_return):
		frappe.throw(_("Delivery Note Return {0} does not exist.").format(dmr.delivery_note_return))
	dn_return = frappe.get_doc("Delivery Note", dmr.delivery_note_return)
	if not dn_return.get("is_return"):
		frappe.throw(_("Delivery Note {0} is not a Return document.").format(dmr.delivery_note_return))
	if dn_return.docstatus != 1:
		frappe.throw(_("Delivery Note Return {0} must be submitted before internal transfer.").format(dmr.delivery_note_return))
	if dmr.original_delivery_note and dn_return.get("return_against") != dmr.original_delivery_note:
		frappe.throw(_("Delivery Note Return must be against original Delivery Note {0}.").format(dmr.original_delivery_note))


def _new_transfer_stock_entry(dmr):
	stock_entry = frappe.new_doc("Stock Entry")
	stock_entry.company = dmr.company
	stock_entry.purpose = "Material Transfer"
	if frappe.db.exists("Stock Entry Type", "Transfer"):
		stock_entry.stock_entry_type = "Transfer"
	elif frappe.db.exists("Stock Entry Type", "Material Transfer"):
		stock_entry.stock_entry_type = "Material Transfer"
	stock_entry.posting_date = nowdate()
	meta = frappe.get_meta("Stock Entry")
	if meta.has_field("custom_purpose_of_transfer"):
		stock_entry.custom_purpose_of_transfer = "NG Transfer"
	if meta.has_field("custom_reference_number"):
		stock_entry.custom_reference_number = dmr.name
	return stock_entry


def _add_stock_entry_item(stock_entry, item_code: str, qty: float, source_warehouse: str, target_warehouse: str):
	if not source_warehouse or not target_warehouse:
		frappe.throw(_("Source Warehouse and Target Warehouse are required."))
	row = stock_entry.append("items", {})
	row.item_code = item_code
	row.qty = qty
	row.s_warehouse = source_warehouse
	row.t_warehouse = target_warehouse


def confirm_ipqc_defect(check_name: str, remarks: str | None = None, create_dmr: bool = False) -> dict:
	check = frappe.get_doc("Production Quality Check", check_name)
	check_document_permission(check, "write")
	if check.docstatus != 1:
		frappe.throw(_("Production Quality Check {0} must be submitted before confirming IPQC defect.").format(check.name))
	if check.quality_node != "Patrol" or check.overall_status != "Rejected":
		frappe.throw(_("Only rejected Patrol checks can be confirmed through this API."))
	dmr_name = check.get("dmr")
	if create_dmr and not dmr_name:
		dmr_name = make_dmr_from_source("Production Quality Check", check.name, dmr_type="IPQC")
		check.db_set("dmr", dmr_name, update_modified=False)
	if remarks:
		check.db_set("disposition_remarks", remarks, update_modified=False)
	check.db_set("defect_confirmation_status", "Confirmed", update_modified=True)
	return {"check": check.name, "dmr": dmr_name}


def build_dmr_notification_payload(dmr_name: str, event: str, extra: dict | None = None) -> dict:
	dmr = frappe.get_doc("DMR", dmr_name)
	payload = {
		"event": event,
		"dmr": dmr.name,
		"dmr_type": dmr.dmr_type,
		"status": dmr.status,
		"escalation_level": dmr.escalation_level,
		"company": dmr.company,
		"item_code": dmr.item_code,
		"qty": dmr.qty,
		"uom": dmr.uom,
		"source_doctype": dmr.source_doctype,
		"source_name": dmr.source_name,
		"supplier": dmr.supplier,
		"customer": dmr.customer,
	}
	if extra:
		payload.update(extra)
	return payload


def notify_dmr_event(dmr_name: str, event: str, extra: dict | None = None) -> dict:
	# Integration point for future WeCom/email workflow notifications.
	return build_dmr_notification_payload(dmr_name, event, extra=extra)
