from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

from jce_quality.services.dmr import DMR_TYPE_SOURCE_MAP


class DMR(Document):
	def validate(self):
		self.set_default_source_doctype()
		if self.item_code:
			item = frappe.db.get_value("Item", self.item_code, ["item_name", "stock_uom"], as_dict=True)
			if item:
				self.item_name = item.item_name
				self.uom = self.uom or item.stock_uom
		self.validate_type_fields()
		self.validate_reinspection_results()
		if self.defect_code:
			defect = frappe.db.get_value(
				"Quality Defect Code",
				self.defect_code,
				["defect_name", "severity", "disabled"],
				as_dict=True,
			)
			if defect:
				if defect.disabled:
					frappe.throw(_("Defect Code {0} is disabled.").format(self.defect_code))
				self.defect_description = self.defect_description or defect.defect_name
				self.severity = self.severity or defect.severity

	@frappe.whitelist()
	def make_customer_exchange_stock_entry(self):
		from jce_quality.services.dmr import make_customer_exchange_stock_entry

		return make_customer_exchange_stock_entry(self.name)

	@frappe.whitelist()
	def make_reinspection_stock_entry(self):
		from jce_quality.services.dmr import make_reinspection_stock_entry

		return make_reinspection_stock_entry(self.name)

	@frappe.whitelist()
	def escalate(self, level: str | None = None):
		from jce_quality.services.permissions import require_quality_disposition_access

		require_quality_disposition_access()
		if level:
			self.db_set("escalation_level", level)
		self.db_set("status", "Escalated")
		return self.name

	def get_reinspection_qty(self, result: str) -> float:
		return sum(
			flt(row.qty)
			for row in self.get("reinspection_results", [])
			if (row.get("result_type") or row.get("result")) == result
		)

	def validate_type_fields(self):
		if self.dmr_type != "IQC":
			self.supplier = None
		if self.dmr_type != "Customer Complaint":
			self.customer = None
		if self.dmr_type != "Customer Complaint":
			self.customer_requirement = None
			self.actual_return_qty = 0
			self.actual_exchange_qty = 0
			self.delivery_note_return = None
			self.return_reason = None
		elif self.customer_requirement == "Return":
			self.return_reason = self.return_reason or "DMR-REJ"
			if self.return_reason != "DMR-REJ":
				frappe.throw(_("Return Reason must be DMR-REJ for customer return DMR."))
		elif self.customer_requirement == "Exchange":
			self.actual_return_qty = 0
			self.delivery_note_return = None
			self.return_reason = None
		if self.dmr_type != "IQC":
			self.requires_return_rejection = 0
			self.return_rejection_status = None
			self.purchase_return = None
		elif self.requires_return_rejection and not self.return_rejection_status:
			self.return_rejection_status = "Pending"
		elif not self.requires_return_rejection and not self.return_rejection_status:
			self.return_rejection_status = "Not Required"

	def set_default_source_doctype(self):
		if self.dmr_type and not self.source_doctype:
			self.source_doctype = DMR_TYPE_SOURCE_MAP.get(self.dmr_type)

	def validate_reinspection_results(self, require_exact: bool = False):
		if self.dmr_type != "Customer Complaint":
			self.set("reinspection_results", [])
			return

		has_result_qty = any(flt(row.qty) > 0 for row in self.get("reinspection_results", []))
		limit_qty = self.get_reinspection_limit(has_result_qty=has_result_qty or require_exact)
		total_qty = 0
		for row in self.get("reinspection_results", []):
			row.item_code = self.item_code
			row.uom = row.uom or self.uom
			qty = flt(row.qty)
			if qty < 0:
				frappe.throw(_("Row #{0}: Reinspection quantity cannot be negative.").format(row.idx))
			total_qty += qty

		if (has_result_qty or require_exact) and flt(total_qty) != flt(limit_qty):
			frappe.throw(
				_("Reinspection OK/NG quantity {0} must equal {1} {2}.").format(
					total_qty,
					self.get_reinspection_limit_label(),
					limit_qty,
				)
			)

	def get_reinspection_limit(self, has_result_qty: bool = False) -> float:
		limit_qty = flt(self.get(self.get_reinspection_limit_fieldname()))
		if has_result_qty and limit_qty <= 0:
			frappe.throw(
				_("{0} is required before recording reinspection results.").format(
					self.get_reinspection_limit_label()
				)
			)
		return limit_qty

	def get_reinspection_limit_fieldname(self) -> str:
		return "actual_return_qty" if self.customer_requirement == "Return" else "actual_exchange_qty"

	def get_reinspection_limit_label(self) -> str:
		return _("Actual Return Qty") if self.customer_requirement == "Return" else _("Actual Exchange Qty")
