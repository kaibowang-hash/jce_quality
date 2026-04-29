frappe.ui.form.on("Quality Defect Code", {
	refresh(frm) {
		frm.set_intro(__("Use concise, stable defect codes so analytics stay clean over time."));
	},
});
