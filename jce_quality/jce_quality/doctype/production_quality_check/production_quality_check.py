import frappe
from frappe.model.document import Document
from frappe.utils import flt, now_datetime

from jce_quality.services.quality import (
	DELIVERY_NOTE_OQC_SOURCE_TYPE,
	DELIVERY_PLAN_OQC_SOURCE_TYPE,
	MANUAL_PRODUCTION_SOURCE_TYPE,
	PRODUCTION_SOURCE_TYPE,
	inspect_and_set_status,
	get_delivery_plan_doc,
	get_delivery_note_doc,
	load_template_readings,
	populate_manual_check_defaults,
	populate_check_from_scheduling,
	prepare_check_for_terminal,
	sync_delivery_plan_oqc_status_for_check,
	sync_scheduling_item_quality_status,
	validate_sample_reference,
)


class ProductionQualityCheck(Document):
	def before_insert(self):
		if not self.inspected_by or self.inspected_by == "user":
			self.inspected_by = frappe.session.user if frappe.session.user != "Guest" else "Administrator"
		self.set_default_source_type()
		populate_check_from_scheduling(self)
		populate_manual_check_defaults(self)
		load_template_readings(self)
		prepare_check_for_terminal(self)

	def validate(self):
		self.set_default_source_type()
		self.validate_source()
		populate_check_from_scheduling(self)
		populate_manual_check_defaults(self)
		prepare_check_for_terminal(self)
		if self.sample_manager:
			validate_sample_reference(self)
		self.set_defect_details()
		self.set_photo_details()
		if self.docstatus == 0 and self.get("sample_readings"):
			inspect_and_set_status(self, require_values=False)

		if self.docstatus == 0 and self.status not in ("In Progress", "Draft"):
			self.status = "Draft"

	def before_submit(self):
		prepare_check_for_terminal(self)
		validate_sample_reference(self)
		inspect_and_set_status(self, require_values=True)
		self.inspection_finished_at = self.inspection_finished_at or now_datetime()
		self.status = self.overall_status
		if self.quality_node == "Patrol" and self.overall_status == "Rejected":
			self.defect_confirmation_status = "Pending"

	def on_submit(self):
		sync_scheduling_item_quality_status(self.scheduling_item)
		sync_delivery_plan_oqc_status_for_check(self)
		close_open_patrol_reminders(self)

	def on_cancel(self):
		self.status = "Cancelled"
		sync_scheduling_item_quality_status(self.scheduling_item)
		sync_delivery_plan_oqc_status_for_check(self)

	def on_update(self):
		if not self.docstatus:
			sync_delivery_plan_oqc_status_for_check(self)

	def on_update_after_submit(self):
		self.set_photo_details()
		sync_scheduling_item_quality_status(self.scheduling_item)
		sync_delivery_plan_oqc_status_for_check(self)

	def set_default_source_type(self):
		if self.source_type:
			return
		if self.work_order_scheduling or self.scheduling_item:
			self.source_type = PRODUCTION_SOURCE_TYPE
		elif self.source_doctype == "Delivery Plan":
			self.source_type = DELIVERY_PLAN_OQC_SOURCE_TYPE
		elif self.source_doctype == "Delivery Note" or self.quality_node == "OQC":
			self.source_type = DELIVERY_NOTE_OQC_SOURCE_TYPE
		else:
			self.source_type = MANUAL_PRODUCTION_SOURCE_TYPE

	def validate_source(self):
		if self.source_type == PRODUCTION_SOURCE_TYPE:
			if not (self.work_order_scheduling and self.scheduling_item):
				frappe.throw(frappe._("Work Order Scheduling and Scheduling Item are required for production scheduling checks."))
			return
		if self.source_type == MANUAL_PRODUCTION_SOURCE_TYPE:
			if not (self.item_code and self.workstation):
				frappe.throw(frappe._("Item Code and Workstation are required for manual production checks."))
			return
		if self.source_type == DELIVERY_NOTE_OQC_SOURCE_TYPE:
			if self.quality_node != "OQC":
				frappe.throw(frappe._("Delivery Note OQC checks must use OQC quality node."))
			if not (self.source_doctype == "Delivery Note" and self.source_name and self.item_code):
				frappe.throw(frappe._("Delivery Note, source detail, and item are required for OQC checks."))
			get_delivery_note_doc(self.source_name, require_submitted=False, allow_return=False)
			return
		if self.source_type == DELIVERY_PLAN_OQC_SOURCE_TYPE:
			if self.quality_node != "OQC":
				frappe.throw(frappe._("Delivery Plan OQC checks must use OQC quality node."))
			if not (self.source_doctype == "Delivery Plan" and self.source_name and self.source_detail and self.item_code):
				frappe.throw(frappe._("Delivery Plan, source detail, and item are required for OQC checks."))
			get_delivery_plan_doc(self.source_name)
			return
		frappe.throw(frappe._("Invalid quality check source type {0}.").format(self.source_type))

	@frappe.whitelist()
	def start_inspection(self):
		from jce_quality.services.permissions import require_quality_execution_access

		require_quality_execution_access()
		if self.docstatus:
			return
		self.db_set("inspection_started_at", self.inspection_started_at or now_datetime(), update_modified=False)
		self.db_set("status", "In Progress", update_modified=True)

	def set_defect_details(self):
		for row in self.get("defects", []):
			if not row.defect_code:
				continue
			defect = frappe.db.get_value(
				"Quality Defect Code",
				row.defect_code,
				["defect_name", "category", "severity", "description", "disabled"],
				as_dict=True,
			)
			if not defect:
				continue
			if defect.disabled:
				frappe.throw(frappe._("Defect Code {0} is disabled.").format(row.defect_code))
			row.defect_name = defect.defect_name
			row.category = defect.category
			row.severity = defect.severity
			if row.meta.has_field("description"):
				row.description = defect.description
			if not flt(row.quantity):
				row.quantity = 1

	def set_photo_details(self):
		for row in self.get("defect_photos", []):
			if row.image and not row.uploaded_by:
				row.uploaded_by = frappe.session.user
			if row.image and not row.uploaded_at:
				row.uploaded_at = now_datetime()


def close_open_patrol_reminders(doc):
	if doc.quality_node != "Patrol" or doc.docstatus != 1:
		return
	from jce_quality.services.reminders import close_reminders_for_check

	close_reminders_for_check(doc)
