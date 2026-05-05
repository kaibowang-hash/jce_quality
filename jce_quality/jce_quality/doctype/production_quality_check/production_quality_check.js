frappe.ui.form.on("Production Quality Check", {
	refresh(frm) {
		frm.set_query("defect_code", "defects", () => ({
			filters: { disabled: 0 },
		}));

		if (!frm.doc.__islocal && frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Start Inspection"), () => {
				frm.call("start_inspection").then(() => frm.reload_doc());
			});
		}

		if (frm.doc.docstatus === 1 && frm.doc.overall_status === "Rejected") {
			frm.add_custom_button(__("Set Disposition"), () => set_disposition(frm), __("Quality"));
			frm.add_custom_button(__("Create DMR"), () => create_dmr_from_check(frm), __("Quality"));
			if (frm.doc.quality_node === "Patrol" && frm.doc.defect_confirmation_status === "Pending") {
				frm.add_custom_button(__("Confirm IPQC Defect"), () => confirm_ipqc_defect(frm), __("Quality"));
			}
			if (frm.doc.disposition === "Concession Release" && !frm.doc.release_approved) {
				frm.add_custom_button(__("Approve Concession Release"), () => {
					frappe.call({
						method: "jce_quality.api.quality.approve_concession_release",
						args: { check_name: frm.doc.name },
					}).then(() => frm.reload_doc());
				}, __("Quality"));
			}
		}
	},

	quality_inspection_template(frm) {
		if (!frm.doc.quality_inspection_template || frm.doc.readings?.length) return;
		frappe.call({
			method: "jce_quality.api.quality.reload_template_readings",
			args: { check_name: frm.doc.name, template: frm.doc.quality_inspection_template },
		}).then(() => frm.reload_doc());
	},

	sample_manager(frm) {
		if (!frm.doc.sample_manager) return;
		frappe.db.get_value("Sample Manager", frm.doc.sample_manager, ["sample_ref", "status", "sample_type"]).then((r) => {
			if (!r.message) return;
			frm.set_value("sample_ref", r.message.sample_ref);
			frm.set_value("sample_status", r.message.status);
			frm.set_value("sample_type", r.message.sample_type);
		});
	},
});

function set_disposition(frm) {
	const dialog = new frappe.ui.Dialog({
		title: __("NG Disposition"),
		fields: [
			{
				fieldname: "disposition",
				fieldtype: "Select",
				label: __("Disposition"),
				options: "\nTemporary Continue\nStop Production\nRework\nScrap\nConcession Release",
				reqd: 1,
				default: frm.doc.disposition,
			},
			{
				fieldname: "remarks",
				fieldtype: "Small Text",
				label: __("Remarks"),
				default: frm.doc.disposition_remarks,
			},
		],
		primary_action_label: __("Save"),
		primary_action(values) {
			frappe.call({
				method: "jce_quality.api.quality.set_disposition",
				args: {
					check_name: frm.doc.name,
					disposition: values.disposition,
					remarks: values.remarks,
				},
			}).then(() => {
				dialog.hide();
				frm.reload_doc();
			});
		},
	});
	dialog.show();
}

function create_dmr_from_check(frm) {
	const create = (dmr_type) => {
		frappe.call({
			method: "jce_quality.api.dmr.create_dmr_from_source",
			args: {
				source_doctype: "Production Quality Check",
				source_name: frm.doc.name,
				item_code: frm.doc.item_code,
				dmr_type,
			},
			freeze: true,
			freeze_message: __("Creating DMR..."),
		}).then((r) => {
			if (r.message) frappe.set_route("Form", "DMR", r.message);
		});
	};
	if (frm.doc.quality_node === "Patrol") {
		create("IPQC");
		return;
	}
	if (frm.doc.quality_node === "Final Release") {
		create("OQC");
		return;
	}
	frappe.prompt(
		[
			{
				fieldname: "dmr_type",
				fieldtype: "Select",
				label: __("DMR Type"),
				options: "\nIPQC\nOQC",
				reqd: 1,
			},
		],
		(values) => create(values.dmr_type),
		__("Create DMR")
	);
}

function confirm_ipqc_defect(frm) {
	frappe.prompt(
		[{ fieldname: "remarks", fieldtype: "Small Text", label: __("Remarks") }],
		(values) => {
			frappe.call({
				method: "jce_quality.api.quality.confirm_ipqc_defect",
				args: {
					check_name: frm.doc.name,
					remarks: values.remarks,
					create_dmr: 0,
				},
				freeze: true,
				freeze_message: __("Confirming defect..."),
			}).then(() => {
				frm.reload_doc();
			});
		},
		__("Confirm IPQC Defect")
	);
}
