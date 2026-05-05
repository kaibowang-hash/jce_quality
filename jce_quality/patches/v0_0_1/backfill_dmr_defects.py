import frappe


def execute():
	if not frappe.db.exists("DocType", "DMR") or not frappe.db.exists("DocType", "DMR Defect"):
		return
	rows = frappe.get_all(
		"DMR",
		filters={"defect_code": ("is", "set")},
		fields=["name", "defect_code", "defect_description", "qty", "severity"],
		limit_page_length=0,
	)
	for row in rows:
		if frappe.db.exists("DMR Defect", {"parent": row.name, "parenttype": "DMR", "defect_code": row.defect_code}):
			continue
		doc = frappe.get_doc("DMR", row.name)
		doc.append(
			"defects",
			{
				"defect_code": row.defect_code,
				"quantity": row.qty or 1,
				"description": row.defect_description,
				"severity": row.severity,
			},
		)
		doc.save(ignore_permissions=True)
