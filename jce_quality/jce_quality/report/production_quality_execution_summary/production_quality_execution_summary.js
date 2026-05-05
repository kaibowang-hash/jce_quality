frappe.query_reports["Production Quality Execution Summary"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_days(frappe.datetime.get_today(), -7) },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today() },
		{ fieldname: "work_order_scheduling", label: __("Work Order Scheduling"), fieldtype: "Link", options: "Work Order Scheduling" },
		{ fieldname: "work_order", label: __("Work Order"), fieldtype: "Link", options: "Work Order" },
		{ fieldname: "workstation", label: __("Workstation"), fieldtype: "Link", options: "Workstation" },
		{ fieldname: "item_code", label: __("Item Code"), fieldtype: "Link", options: "Item" },
	],
	formatter(value, row, column, data, default_formatter) {
		const formatted = default_formatter(value, row, column, data);
		if (!data?.has_defect) {
			return formatted;
		}
		return `<div class="jce-pqes-defect-cell">${formatted || ""}</div>`;
	},
	onload() {
		if (document.getElementById("jce-pqes-style")) {
			return;
		}
		frappe.dom.set_style(`
			.jce-pqes-defect-cell {
				min-height: 33px;
				width: calc(100% + 16px);
				display: flex;
				align-items: center;
				margin: -8px;
				padding: 8px;
				background: #fff1f2;
				color: #8f1d2c;
				font-weight: 650;
			}
			.dt-cell__content .jce-pqes-defect-cell a {
				color: #8f1d2c;
				font-weight: 750;
			}
		`, "jce-pqes-style");
	},
};
