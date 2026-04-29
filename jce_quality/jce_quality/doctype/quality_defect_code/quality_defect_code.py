import frappe
from frappe.model.document import Document


class QualityDefectCode(Document):
	def validate(self):
		if self.defect_code:
			self.defect_code = self.defect_code.strip()
		if not self.defect_name:
			self.defect_name = self.defect_code
