frappe.ui.form.on("Quality Inspection Template", {
	refresh(frm) {
		["quality_inspection_template_name", "version", "naming_dd", "status", "current_effective", "af_reference"].forEach((fieldname) => {
			frm.set_df_property(fieldname, "read_only", 1);
		});
		frm.set_df_property("quality_inspection_template_name", "hidden", 1);
		if (frm.doc.status === "Suspended") {
			frm.dashboard.set_headline_alert(
				__("Current Item AF has changed. Create a new template version before making this template current again."),
				"orange"
			);
		}
		if (frm.is_new() || !frm.doc.item_code || ["Obsolete", "Cancelled"].includes(frm.doc.status)) return;
		frm.add_custom_button(__("Update Version"), () => {
			frappe.prompt(
				[
					{
						fieldname: "update_reason",
						label: __("Update Reason"),
						fieldtype: "Small Text",
						reqd: 1,
					},
				],
				(values) => {
					frappe.call({
						method: "jce_quality.api.template.create_next_quality_inspection_template_version",
						args: {
							template_name: frm.doc.name,
							update_reason: values.update_reason,
						},
						freeze: true,
						freeze_message: __("Creating new template version..."),
					}).then((r) => {
						if (r.message) frappe.set_route("Form", "Quality Inspection Template", r.message);
					});
				},
				__("Update Quality Inspection Template Version")
			);
		});
	},

	item_code(frm) {
		if (!frm.doc.item_code) return;
		frappe.db.get_value("Item", frm.doc.item_code, ["item_name", "custom_af_reference", "drawing_file"]).then((r) => {
			const values = r.message || {};
			frm.set_value("item_name", values.item_name || "");
			frm.set_value("af_reference", values.custom_af_reference || "");
			if (values.drawing_file && !frm.doc.drawing_file) {
				frm.set_value("drawing_file", values.drawing_file);
			}
		});
	},
});
