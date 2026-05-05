frappe.ui.form.on("DMR", {
	refresh(frm) {
		frm.page.set_title(__("DMR - Defect Material Report") + (frm.doc.name ? ` ${frm.doc.name}` : ""));
		sync_source_doctype(frm);
		sync_reinspection_items(frm);
		if (frm.doc.dmr_type === "Customer Complaint" && !frm.is_new()) {
			if (frm.doc.customer_requirement === "Exchange") {
				frm.add_custom_button(__("Print Exchange Order"), () => frm.print_doc(), __("Print"));
				if (!frm.doc.first_exchange_stock_entry && can_create_stock_transfer(frm)) {
					frm.add_custom_button(__("Create Exchange Transfer"), () => {
						frm.call({
							method: "make_customer_exchange_stock_entry",
							freeze: true,
							freeze_message: __("Creating Stock Entry draft..."),
						}).then((r) => {
							if (r.message) frappe.set_route("Form", "Stock Entry", r.message);
						});
					}, __("Stock Entry"));
				} else {
					frm.add_custom_button(__("View Exchange Transfer"), () => {
					frappe.set_route("Form", "Stock Entry", frm.doc.first_exchange_stock_entry);
				}, __("Stock Entry"));
				}
			}
			if (!frm.doc.disposition_stock_entry && (frm.doc.reinspection_results || []).length && can_create_stock_transfer(frm)) {
				frm.add_custom_button(__("Create Reinspection Transfer"), () => {
					frm.call({
						method: "make_reinspection_stock_entry",
						freeze: true,
						freeze_message: __("Creating Stock Entry draft..."),
					}).then((r) => {
						if (r.message) frappe.set_route("Form", "Stock Entry", r.message);
					});
				}, __("Stock Entry"));
			} else if (frm.doc.disposition_stock_entry) {
				frm.add_custom_button(__("View Reinspection Transfer"), () => {
					frappe.set_route("Form", "Stock Entry", frm.doc.disposition_stock_entry);
				}, __("Stock Entry"));
			}
		}
	},

	dmr_type(frm) {
		sync_source_doctype(frm, true);
		sync_reinspection_items(frm);
	},

	item_code(frm) {
		sync_reinspection_items(frm);
	},

	reinspection_results_add(frm, _cdt, cdn) {
		const row = locals["DMR Reinspection Result"][cdn];
		row.item_code = frm.doc.item_code;
		row.uom = frm.doc.uom;
		frm.refresh_field("reinspection_results");
	},
});

const DMR_SOURCE_MAP = {
	IQC: "Quality Inspection",
	IPQC: "Production Quality Check",
	OQC: "Production Quality Check",
	"Customer Complaint": "Delivery Note",
};

function can_create_stock_transfer(frm) {
	if (frappe.user_roles.includes("System Manager")) {
		return ["Pending Disposition", "Return Rejection Completed"].includes(frm.doc.status);
	}
	const has_stock_role = frappe.user_roles.includes("Stock User")
		|| frappe.user_roles.includes("Stock Manager");
	return ["Pending Disposition", "Return Rejection Completed"].includes(frm.doc.status)
		&& frappe.user_roles.includes("Quality Manager")
		&& has_stock_role;
}

function sync_source_doctype(frm, force = false) {
	const expected = DMR_SOURCE_MAP[frm.doc.dmr_type];
	if (expected && (force || !frm.doc.source_doctype)) {
		frm.set_value("source_doctype", expected);
	}
}

function sync_reinspection_items(frm) {
	(frm.doc.reinspection_results || []).forEach((row) => {
		row.item_code = frm.doc.item_code;
		row.uom = row.uom || frm.doc.uom;
	});
	frm.refresh_field("reinspection_results");
}
