frappe.ui.form.on("Quality Inspection", {
	refresh(frm) {
		if (!frm.is_new()) add_make_dmr_button(frm);
	},
});

frappe.ui.form.on("Delivery Note", {
	refresh(frm) {
		if (!frm.is_new()) add_make_dmr_button(frm);
	},
});

function add_make_dmr_button(frm) {
	frm.add_custom_button(__("Create DMR"), () => {
		const item_options = frm.doc.doctype === "Quality Inspection"
			? [frm.doc.item_code].filter(Boolean)
			: [...new Set((frm.doc.items || []).map((row) => row.item_code).filter(Boolean))];
		if (!item_options.length) {
			frappe.msgprint(__("No item rows available for DMR."));
			return;
		}
		const fields = [];
		if (item_options.length > 1) {
			fields.push({
				fieldname: "item_code",
				fieldtype: "Select",
				label: __("Item Code"),
				options: ["", ...item_options].join("\n"),
				reqd: 1,
			});
		}
		const create = (values = {}) => {
			frappe.call({
				method: "jce_quality.api.dmr.create_dmr_from_source",
				args: {
					source_doctype: frm.doc.doctype,
					source_name: frm.doc.name,
					item_code: values.item_code || item_options[0],
					dmr_type: frm.doc.doctype === "Quality Inspection" ? "IQC" : "Customer Complaint",
				},
				freeze: true,
				freeze_message: __("Creating DMR..."),
			}).then((r) => {
				if (r.message) frappe.set_route("Form", "DMR", r.message);
			});
		};
		if (fields.length) frappe.prompt(fields, create, __("Create DMR"));
		else create();
	});
}
