frappe.pages["quality-inspection-terminal"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Quality Inspection Terminal"),
		single_column: true,
	});
	wrapper.quality_terminal = new QualityInspectionTerminal(page, wrapper);
};

frappe.pages["quality-inspection-terminal"].on_page_show = function (wrapper) {
	wrapper.quality_terminal?.update_fullscreen_class?.(true);
	wrapper.quality_terminal?.handle_route_options?.();
	wrapper.quality_terminal?.refresh();
};

frappe.pages["quality-inspection-terminal"].on_page_hide = function (wrapper) {
	$("body").removeClass("jce-quality-terminal-focus-active jce-quality-terminal-fullscreen-active");
	wrapper.quality_terminal?.body?.removeClass("jce-terminal-fullscreen");
};

const DRAWING_WIDTH_KEY = "jce_quality_terminal_drawing_width";
const PDFJS_SRC = "/assets/jce_quality/vendor/pdfjs/pdf.min.js";
const PDFJS_WORKER = "/assets/jce_quality/vendor/pdfjs/pdf.worker.min.js";
const PRODUCTION_QUALITY_NODES = ["First Article", "Patrol", "Last Article", "Final Release"];
const OQC_SOURCE_TYPES = ["Delivery Note OQC", "Delivery Plan OQC"];
const JCE_TERMINAL_OQC_STATE_KEY = "jce_quality_terminal_oqc_filters";

class QualityInspectionTerminal {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = $(wrapper);
		this.mode = "task-list";
		this.selectedTask = null;
		this.current = null;
		this.activePane = "inspection";
		this.drawingHidden = false;
		this.drawerOpen = false;
		this.filters = {
			posting_date: frappe.datetime.get_today(),
			plant_floor: "",
			shift_type: "",
			work_order_scheduling: "",
		};
		this.canUseDeliveryPlan = can_read_doctype("Delivery Plan");
		this.oqcFilters = {
			source_type: "Delivery Note",
			from_date: frappe.datetime.add_days(frappe.datetime.get_today(), -7),
			to_date: frappe.datetime.get_today(),
			customer: "",
			delivery_note: "",
			delivery_plan: "",
		};
		Object.assign(this.oqcFilters, this.get_stored_oqc_filters());
		this.normalize_oqc_filters();
		this.drawingWidth = this.get_stored_drawing_width();
		this.drawing_state = {};
		this.defect_options = [];
		this.pdfjs_promise = null;
		this.tasks = [];
		this.oqcDeliveryNotes = [];
		this.oqcItems = [];
		this.oqcControls = {};
		this.refreshRequestId = 0;
		this.oqcRequestId = 0;
		this.oqcItemsRequestId = 0;
		this.refreshTimer = null;
		this.oqcRefreshTimer = null;
		this.filtersRendered = false;
		this.fullscreenActive = true;
		this.nativeFullscreenRequested = false;
		this.defectControlCounter = 0;
		this.ngActionDialogShown = new Set();
		this.returnMode = "task-list";
		const routeOptions = clean_route_options(frappe.route_options || {});
		frappe.route_options = null;
		this.initialCheckName = routeOptions.check_name || "";
		delete routeOptions.check_name;
		this.apply_filter_route_options(routeOptions);
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh(), "es-line-reload");
		this.body = $(`<div class="jce-q-terminal"></div>`).appendTo(this.page.body);
		this.inject_style();
		this.install_pwa_head();
		this.bind_fullscreen_change();
		this.render_task_list_view();
		this.load_defect_options();
		if (this.initialCheckName) {
			const checkName = this.initialCheckName;
			this.initialCheckName = "";
			this.open_check_by_name(checkName, null);
		}
	}

	handle_route_options() {
		const routeOptions = clean_route_options(frappe.route_options || {});
		frappe.route_options = null;
		if (!Object.keys(routeOptions).length) return false;
		const checkName = routeOptions.check_name || "";
		const targetMode = routeOptions.mode || "";
		delete routeOptions.check_name;
		delete routeOptions.mode;
		this.apply_filter_route_options(routeOptions);
		this.sync_filter_controls();
		if (checkName) {
			this.open_check_by_name(checkName, null);
			return true;
		}
		if (targetMode === "oqc") {
			this.render_oqc_terminal_view();
			return true;
		}
		return false;
	}

	apply_filter_route_options(options) {
		const allowed = new Set(["posting_date", "plant_floor", "shift_type", "work_order_scheduling"]);
		Object.keys(options || {}).forEach((fieldname) => {
			if (allowed.has(fieldname)) {
				this.filters[fieldname] = options[fieldname] || "";
			}
		});
	}

	sync_filter_controls() {
		Object.entries(this.controls || {}).forEach(([fieldname, control]) => {
			if (Object.prototype.hasOwnProperty.call(this.filters, fieldname)) {
				control.set_value(this.filters[fieldname] || "");
			}
		});
	}

	refresh() {
		if (this.mode === "oqc") {
			return this.refresh_oqc_delivery_notes();
		}
		const requestId = ++this.refreshRequestId;
		clearTimeout(this.refreshTimer);
		frappe.dom?.unfreeze?.();
		if (this.mode === "task-list") {
			this.render_task_loading();
		}
		this.refreshTimer = setTimeout(() => {
			if (requestId !== this.refreshRequestId) return;
			frappe.dom?.unfreeze?.();
			if (this.mode === "task-list") {
				this.render_task_error(__("Loading quality tasks is taking longer than expected. Please refresh the page or sign in again."));
			}
		}, 15000);

		const request = frappe.call({
			method: "jce_quality.api.quality.get_terminal_task_list",
			args: this.filters,
		});

		return Promise.resolve(request).then((r) => {
			if (requestId !== this.refreshRequestId) return;
			this.tasks = r.message || [];
			if (this.mode === "task-list") {
				this.render_tasks();
			} else if (this.drawerOpen) {
				this.render_task_drawer();
			}
		}).catch((error) => {
			if (requestId !== this.refreshRequestId) return;
			console.error(error);
			if (this.mode === "task-list") {
				this.render_task_error(__("Unable to load quality tasks. Please refresh the page or sign in again."));
			}
		}).finally(() => {
			if (requestId !== this.refreshRequestId) return;
			clearTimeout(this.refreshTimer);
			frappe.dom?.unfreeze?.();
		});
	}

	render_task_loading() {
		const list = this.body.find(".jce-q-task-list");
		if (!list.length) return;
		list.html(`<div class="jce-q-empty">${__("Loading quality tasks...")}</div>`);
	}

	render_task_error(message) {
		const list = this.body.find(".jce-q-task-list");
		if (!list.length) return;
		list.html(`
			<div class="jce-q-empty">
				<div>${esc(message)}</div>
				<button class="jce-q-small-button primary" data-action="retry-refresh">${__("Refresh")}</button>
			</div>
		`);
		list.find('[data-action="retry-refresh"]').on("click", () => this.refresh());
	}

	render_task_list_view() {
		this.mode = "task-list";
		this.drawerOpen = false;
		this.selectedTask = null;
		this.sampleControl = null;
		this.filtersRendered = false;
		this.nativeFullscreenRequested = false;
		this.body.removeClass("jce-terminal-focus");
		this.update_fullscreen_class(true);
		this.body.html(`
			<div class="jce-q-task-shell">
				<section class="jce-q-list-header">
					<div>
						<span class="jce-q-eyebrow">${__("Quality Inspection")}</span>
						<h2>${__("Inspection Queue")}</h2>
					</div>
					<div class="jce-q-list-actions">
						<div class="jce-q-list-metrics"></div>
						${this.fullscreen_toolbar_button()}
					</div>
				</section>
				<section class="jce-q-entry-panel">
					<button type="button" class="jce-q-entry-action ipqc" data-action="manual-check">
						<span class="jce-q-entry-icon">${icon_html("plus")}</span>
						<span class="jce-q-entry-copy"><b>IPQC</b><em>${__("Manual Production Check")}</em></span>
					</button>
					<button type="button" class="jce-q-entry-action oqc" data-action="oqc-check">
						<span class="jce-q-entry-icon">${icon_html("truck")}</span>
						<span class="jce-q-entry-copy"><b>OQC</b><em>${__("Shipping Inspection")}</em></span>
					</button>
				</section>
				<section class="jce-q-filter-panel">
					<div class="jce-q-filter-head">
						<div class="jce-q-filter-title">${__("Filters")}</div>
						<button class="jce-q-small-button primary icon jce-q-mobile-filter-refresh" title="${__("Refresh")}" aria-label="${__("Refresh")}">${icon_html("refresh-cw")}</button>
					</div>
					<div class="jce-q-toolbar"></div>
				</section>
				${this.render_pwa_hint()}
				<div class="jce-q-task-list"></div>
			</div>
		`);
		this.update_fullscreen_class(true);
		this.body.find('[data-action="fullscreen"]').on("click", () => this.toggle_fullscreen());
		this.body.find(".jce-q-mobile-filter-refresh").on("click", () => this.refresh());
		this.body.find('[data-action="dismiss-pwa-hint"]').on("click", () => this.dismiss_pwa_hint());
		this.body.find('[data-action="manual-check"]').on("click", () => this.open_manual_check_dialog());
		this.body.find('[data-action="oqc-check"]').on("click", () => this.render_oqc_terminal_view());
		this.render_filters();
		this.bind_mobile_input_focus();
		this.render_tasks();
	}

	render_filters() {
		if (this.filtersRendered) return;
		this.filtersRendered = true;
		const toolbar = this.body.find(".jce-q-toolbar");
		toolbar.empty();
		const fields = [
			{ fieldname: "posting_date", label: __("Date"), fieldtype: "Date", default: this.filters.posting_date },
			{ fieldname: "plant_floor", label: __("Plant Floor"), fieldtype: "Link", options: "Plant Floor", default: this.filters.plant_floor },
			{ fieldname: "shift_type", label: __("Shift"), fieldtype: "Select", options: get_shift_options(), default: this.filters.shift_type },
		];
		this.controls = {};
		fields.forEach((df) => {
			const holder = $(`<div class="jce-q-filter jce-q-filter-${df.fieldname}"></div>`).appendTo(toolbar);
			const control = frappe.ui.form.make_control({ parent: holder, df, render_input: true });
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				const value = control.get_value() || "";
				if ((this.filters[df.fieldname] || "") === value) return;
				this.filters[df.fieldname] = value;
				this.refresh();
			});
			this.controls[df.fieldname] = control;
		});
		$(`<div class="jce-q-filter jce-q-filter-action">
				<button class="jce-q-small-button primary icon jce-q-filter-refresh" title="${__("Refresh")}" aria-label="${__("Refresh")}">${icon_html("refresh-cw")}</button>
			</div>`)
			.appendTo(toolbar)
			.find(".jce-q-filter-refresh")
			.on("click", () => this.refresh());
	}

	render_tasks(container = null) {
		const list = container || this.body.find(".jce-q-task-list");
		if (!container) this.render_task_metrics();
		list.empty();
		if (!this.tasks?.length) {
			list.html(`<div class="jce-q-empty">${__("No tasks found.")}</div>`);
			return;
		}

		this.tasks.forEach((task) => {
			const row = $(this.task_card(task)).appendTo(list);
			row.find("[data-node]").on("click", (event) => {
				event.stopPropagation();
				this.open_check(task, event.currentTarget.dataset.node);
			});
			row.find("[data-check-name]").on("click", (event) => {
				event.stopPropagation();
				this.open_check_by_name(event.currentTarget.dataset.checkName, task);
			});
		});
	}

	render_task_metrics() {
		const holder = this.body.find(".jce-q-list-metrics");
		if (!holder.length) return;
		const total = this.tasks?.length || 0;
		const complete = (this.tasks || []).filter((task) => cint(task.quality_complete)).length;
		const alerted = (this.tasks || []).filter((task) => cint(task.quality_alert_open) || task.quality_alert_note).length;
		const frozen = (this.tasks || []).filter((task) => cint(task.frozen)).length;
		holder.html(`
			<div><span>${__("Total")}</span><b>${total}</b></div>
			<div><span>${__("Complete")}</span><b>${complete}</b></div>
			<div><span>${__("Alerts")}</span><b>${alerted}</b></div>
			<div><span>${__("Frozen")}</span><b>${frozen}</b></div>
		`);
	}

	task_card(task) {
		const ng_checks = task.active_ng_checks || [];
		const has_temporary_continue = ng_checks.some((row) => row.disposition_state === "Temporary Continue");
		const frozen = task.frozen ? `<span class="jce-q-pill danger">${__("Production Hold")}</span>` : "";
		const temporary_continue = has_temporary_continue ? `<span class="jce-q-pill warn">${__("Temporary Continue")}</span>` : "";
		const customer_code = clean_value(task.customer_code);
		const patrol_complete = cint(task.patrol_count) >= cint(task.patrol_required_count);
		const patrol_status = task.patrol_status === "Rejected"
			? "Rejected"
			: !cint(task.patrol_required_count)
			? "Not Required"
			: task.patrol_overdue
				? "Overdue"
				: patrol_complete
					? "Accepted"
					: `${cint(task.patrol_count)} / ${cint(task.patrol_required_count)}`;
		const node_buttons = this.render_task_node_buttons(task, patrol_status);
		const alert_note = task.quality_alert_note
			? `<div class="jce-q-task-alert">${esc(task.quality_alert_note)}</div>`
			: "";
		const complete_pill = cint(task.quality_complete)
			? `<span class="jce-q-pill ok">${__("Complete")}</span>`
			: `<span class="jce-q-pill">${__("Open")}</span>`;
		const fai_pill = cint(task.first_article_required) ? `<span class="jce-q-pill fai">FAI</span>` : "";
		const alert_pill = cint(task.quality_alert_open)
			? `<span class="jce-q-pill danger">${__("Alert")}</span>`
			: "";

		return `
			<div class="jce-q-task ${cint(task.first_article_required) ? "has-fai" : ""}">
				<div class="jce-q-task-card-head">
					<span class="jce-q-station">${esc(task.workstation || "-")}</span>
					<div class="jce-q-task-badges">${fai_pill}${complete_pill}${alert_pill}${frozen}${temporary_continue}</div>
				</div>
				<div class="jce-q-task-title">
					<div>
						<b>${esc(task.item_code)}</b>
						${customer_code ? `<em>${__("Customer Code")}: ${esc(customer_code)}</em>` : ""}
						<span>${esc(task.item_name || "")}</span>
					</div>
				</div>
				${alert_note}
				${this.render_task_ng_followups(task)}
				<div class="jce-q-task-meta-grid">
					<div><span>${__("Work Order")}</span><b>${esc(task.work_order || "-")}</b></div>
					<div><span>${__("Qty")}</span><b>${esc(format_float(task.scheduling_qty || 0))}</b></div>
					<div><span>${__("Shift")}</span><b>${esc(task.shift_type || "-")}</b></div>
					<div><span>${__("Extra Patrol")}</span><b>${cint(task.extra_patrol_count) || "-"}</b></div>
				</div>
				<div class="jce-q-node-row">
					${node_buttons || `<div class="jce-q-muted">${__("No mandatory quality tasks.")}</div>`}
				</div>
			</div>
		`;
	}

	render_task_node_buttons(task, patrol_status) {
		return this.get_required_nodes(task)
			.map((node) => this.node_button(node, this.get_task_node_status(task, node, patrol_status), task))
			.join("");
	}

	get_required_nodes(task) {
		if (Array.isArray(task?.required_quality_nodes) && task.required_quality_nodes.length) {
			return task.required_quality_nodes.filter((node) => PRODUCTION_QUALITY_NODES.includes(node));
		}
		const requirements = task?.quality_requirements || {};
		return PRODUCTION_QUALITY_NODES.filter((node) => {
			if (node === "Patrol") return cint(requirements[node]) || cint(task?.patrol_required_count);
			if (node === "First Article") return cint(requirements[node]) || cint(task?.first_article_required);
			if (node === "Last Article") return cint(requirements[node]) || cint(task?.last_article_required);
			if (node === "Final Release") return cint(requirements[node]) || cint(task?.final_release_required);
			return false;
		});
	}

	get_task_node_status(task, node, patrol_status) {
		if (node === "Patrol") return patrol_status;
		if (node === "First Article") return task.first_article_status || "Pending";
		if (node === "Last Article") return task.last_article_status || "Pending";
		if (node === "Final Release") return task.final_release_status || "Pending";
		return "Pending";
	}

	render_task_ng_followups(task) {
		const checks = task.active_ng_checks || [];
		if (!checks.length) return "";
		return `
			<div class="jce-q-task-ng-list">
				<div class="jce-q-task-ng-title">
					<span>${__("NG Tracking")}</span>
					<b>${checks.length} ${__("items")}</b>
				</div>
				${checks.slice(0, 3).map((row) => `
					<button type="button" class="jce-q-task-ng-row ${row.production_blocking ? "danger" : "warn"}" data-check-name="${esc(row.name)}">
						<span>${esc(quality_process_label(row.quality_node))}</span>
						<b>${esc(__(row.disposition_state || "Pending Disposition"))}</b>
					</button>
				`).join("")}
			</div>
		`;
	}

	node_button(node, status, task = null) {
		const tone = status === "Accepted" || status === "Concession Released" ? "ok" : ["Rejected", "Overdue"].includes(status) ? "danger" : status === "Not Required" ? "" : "warn";
		const disabled = status === "Not Required" ? "disabled" : "";
		const fai_pending = node === "Patrol"
			&& cint(task?.first_article_required)
			&& !["Accepted", "Concession Released"].includes(task?.first_article_status || "");
		const hint = fai_pending ? `<em>${__("FAI Pending")}</em>` : "";
		return `<button class="jce-q-node ${tone} ${fai_pending ? "sequence-warn" : ""}" data-node="${esc(node)}" ${disabled}><span>${esc(__(node))}</span><b>${esc(__(status || "Pending"))}</b>${hint}</button>`;
	}

	open_check(task, node) {
		if (!this.get_required_nodes(task).includes(node)) {
			frappe.show_alert({ message: __("{0} is not required for this scheduling item.", [__(node)]), indicator: "orange" });
			return;
		}
		frappe.call({
			method: "jce_quality.api.quality.get_or_create_check",
			args: {
				work_order_scheduling: task.work_order_scheduling,
				scheduling_item: task.name,
				quality_node: node,
			},
			freeze: true,
			freeze_message: __("Opening inspection..."),
		}).then((r) => {
			this.selectedTask = task;
			this.current = r.message;
			this.enter_focus_mode();
		}).catch((error) => {
			console.error(error);
			frappe.show_alert({ message: __("Unable to open inspection."), indicator: "red" });
		});
	}

	open_check_by_name(check_name, task = null) {
		if (!check_name) return;
		frappe.call({
			method: "jce_quality.api.quality.get_check_payload",
			args: { check_name },
			freeze: true,
			freeze_message: __("Opening inspection..."),
		}).then((r) => {
			this.selectedTask = task || null;
			this.current = r.message;
			this.enter_focus_mode();
		}).catch((error) => {
			console.error(error);
			frappe.show_alert({ message: __("Unable to open inspection."), indicator: "red" });
		});
	}

	open_manual_check_dialog() {
		const d = new frappe.ui.Dialog({
			title: __("IPQC Manual Production Check"),
			size: "large",
			fields: [
				{ fieldname: "manual_context_section", fieldtype: "Section Break", label: __("Production Context") },
				{ fieldname: "item_code", fieldtype: "Link", options: "Item", label: __("Item Code"), reqd: 1 },
				{ fieldname: "workstation", fieldtype: "Link", options: "Workstation", label: __("Workstation"), reqd: 1 },
				{ fieldname: "manual_context_column", fieldtype: "Column Break" },
				{ fieldname: "company", fieldtype: "Link", options: "Company", label: __("Company") },
				{ fieldname: "plant_floor", fieldtype: "Link", options: "Plant Floor", label: __("Plant Floor"), default: this.filters.plant_floor },
				{ fieldname: "manual_node_section", fieldtype: "Section Break", label: __("Inspection Node") },
				{ fieldname: "quality_node", fieldtype: "Select", label: __("Quality Node"), options: "\n", reqd: 1 },
				{ fieldname: "node_options_html", fieldtype: "HTML" },
				{ fieldname: "manual_qty_section", fieldtype: "Section Break", label: __("Quantity & Timing") },
				{ fieldname: "qty", fieldtype: "Float", label: __("Qty"), default: 1 },
				{ fieldname: "shift_type", fieldtype: "Data", label: __("Shift"), default: this.filters.shift_type },
				{ fieldname: "manual_qty_column", fieldtype: "Column Break" },
				{ fieldname: "posting_date", fieldtype: "Date", label: __("Date"), default: this.filters.posting_date || frappe.datetime.get_today() },
				{ fieldname: "manual_remarks_section", fieldtype: "Section Break", label: __("Remarks") },
				{ fieldname: "remarks", fieldtype: "Small Text", label: __("Remarks") },
			],
			primary_action_label: __("Create"),
			primary_action: (values) => {
				if (!values.quality_node) {
					frappe.msgprint(__("No mandatory IPQC gate is available for this item and workstation."));
					return;
				}
				frappe.call({
					method: "jce_quality.api.quality.create_manual_production_check",
					args: values,
					freeze: true,
					freeze_message: __("Creating inspection..."),
				}).then((r) => {
					d.hide();
					this.selectedTask = null;
					this.current = r.message;
					this.enter_focus_mode();
				});
			},
		});
		d.$wrapper.addClass("jce-q-manual-check-modal");
		d.show();
		d.$wrapper.find(".modal-dialog").addClass("modal-dialog-scrollable jce-q-manual-check-dialog");
		const refresh_options = () => this.refresh_manual_node_options(d);
		["item_code", "workstation", "company", "plant_floor"].forEach((fieldname) => {
			d.get_field(fieldname)?.$input?.on("change", refresh_options);
		});
		this.refresh_manual_node_options(d);
	}

	refresh_manual_node_options(d) {
		const item_code = d.get_value("item_code");
		const workstation = d.get_value("workstation");
		const field = d.get_field("quality_node");
		const holder = d.get_field("node_options_html")?.$wrapper;
		if (!field) return Promise.resolve();
		if (!item_code || !workstation) {
			field.df.options = "\n";
			field.refresh();
			d.set_value("quality_node", "");
			holder?.html(`<div class="jce-q-empty compact">${__("Select item and workstation.")}</div>`);
			return Promise.resolve();
		}
		holder?.html(`<div class="jce-q-empty compact">${__("Loading mandatory IPQC gates...")}</div>`);
		return frappe.call({
			method: "jce_quality.api.quality.get_manual_production_quality_node_options",
			args: {
				item_code,
				workstation,
				company: d.get_value("company"),
				plant_floor: d.get_value("plant_floor"),
			},
		}).then((r) => {
			const options = r.message || [];
			field.df.options = `\n${options.map((row) => row.value).join("\n")}`;
			field.refresh();
			const current = d.get_value("quality_node");
			if (!options.some((row) => row.value === current)) {
				d.set_value("quality_node", options[0]?.value || "");
			}
			holder?.html(this.render_manual_node_options(options));
		});
	}

	render_manual_node_options(options) {
		if (!options.length) {
			return `<div class="jce-q-empty compact">${__("No mandatory IPQC gate is configured.")}</div>`;
		}
		return `
			<div class="jce-q-manual-node-list">
				${options.map((row) => `
					<span class="jce-q-node-chip">
						<b>${esc(quality_process_label(row.value))}</b>
						<em>${row.required_count > 1 ? esc(__("{0} checks", [row.required_count])) : esc(__("Required"))}</em>
					</span>
				`).join("")}
			</div>
		`;
	}

	render_oqc_terminal_view(options = {}) {
		this.mode = "oqc";
		this.returnMode = "oqc";
		this.drawerOpen = false;
		this.selectedTask = null;
		this.current = null;
		this.oqcControls = {};
		this.body.removeClass("jce-terminal-focus");
		this.update_fullscreen_class(true);
		this.body.html(`
			<div class="jce-q-task-shell jce-q-oqc-shell">
				<section class="jce-q-list-header">
					<div class="jce-q-toolbar-left">
						<div class="jce-q-nav-buttons">
							<button class="jce-q-small-button icon" data-action="back-to-tasks" title="${__("Tasks")}" aria-label="${__("Tasks")}">${icon_html("chevron-left")}</button>
						</div>
						<div>
							<span class="jce-q-eyebrow">${__("Quality Inspection")}</span>
							<h2>${__("OQC Shipping Inspection")}</h2>
						</div>
					</div>
					<div class="jce-q-list-actions">
						<button class="jce-q-small-button primary" data-action="oqc-load">${__("Load")}</button>
						${this.fullscreen_toolbar_button()}
					</div>
				</section>
				<div class="jce-q-oqc-scroll">
					<section class="jce-q-filter-panel oqc">
						<div class="jce-q-filter-title">${__("Filters")}</div>
						<div class="jce-q-toolbar jce-q-oqc-toolbar"></div>
					</section>
					<section class="jce-q-oqc-workspace">
						<div class="jce-q-panel jce-q-oqc-list-panel">
							<div class="jce-q-section-head">
								<div>
									<span>${__("Delivery Note List")}</span>
									<b>${__("Deliveries")}</b>
								</div>
								<span class="jce-q-pill jce-q-oqc-count">0</span>
							</div>
							<div class="jce-q-oqc-delivery-list"></div>
						</div>
						<div class="jce-q-panel jce-q-oqc-items-panel">
							<div class="jce-q-section-head">
								<div>
									<span>${__("OQC Items")}</span>
									<b>${esc(this.oqcFilters.delivery_note || __("Select Delivery Note."))}</b>
								</div>
								<button class="jce-q-small-button" data-action="clear-delivery-note">${__("Back to Delivery Note List")}</button>
							</div>
							<div class="jce-q-oqc-items"></div>
						</div>
					</section>
				</div>
			</div>
		`);
		this.update_fullscreen_class(true);
		this.body.find('[data-action="fullscreen"]').on("click", () => this.toggle_fullscreen());
		this.body.find('[data-action="back-to-tasks"]').on("click", () => {
			this.returnMode = "task-list";
			this.render_task_list_view();
			this.refresh();
		});
		this.body.find('[data-action="oqc-load"]').on("click", () => this.refresh_oqc_delivery_notes());
		this.body.find('[data-action="clear-delivery-note"]').on("click", () => this.select_oqc_delivery_note(""));
		this.render_oqc_filters();
		this.bind_mobile_input_focus();
		if (options.refresh !== false) {
			this.refresh_oqc_delivery_notes();
		}
	}

	get_stored_oqc_filters() {
		try {
			return JSON.parse(localStorage.getItem(JCE_TERMINAL_OQC_STATE_KEY) || "{}") || {};
		} catch (error) {
			console.error(error);
			return {};
		}
	}

	store_oqc_filters() {
		try {
			localStorage.setItem(JCE_TERMINAL_OQC_STATE_KEY, JSON.stringify(this.oqcFilters));
		} catch (error) {
			console.error(error);
		}
	}

	normalize_oqc_filters() {
		if (!this.canUseDeliveryPlan && this.oqcFilters.source_type === "Delivery Plan") {
			this.oqcFilters.source_type = "Delivery Note";
			this.oqcFilters.delivery_plan = "";
		}
		this.oqcFilters.source_type = this.oqcFilters.source_type || "Delivery Note";
	}

	render_oqc_filters() {
		const toolbar = this.body.find(".jce-q-oqc-toolbar");
		toolbar.empty();
		const sourceOptions = this.canUseDeliveryPlan ? "Delivery Note\nDelivery Plan" : "Delivery Note";
		const fields = [
			{ fieldname: "source_type", label: __("Source"), fieldtype: "Select", options: sourceOptions, default: this.oqcFilters.source_type },
			{ fieldname: "delivery_note", label: __("Delivery Note"), fieldtype: "Link", options: "Delivery Note", default: this.oqcFilters.delivery_note },
			{ fieldname: "delivery_plan", label: __("Delivery Plan"), fieldtype: "Link", options: "Delivery Plan", default: this.oqcFilters.delivery_plan },
			{ fieldname: "customer", label: __("Customer"), fieldtype: "Link", options: "Customer", default: this.oqcFilters.customer },
			{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: this.oqcFilters.from_date },
			{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: this.oqcFilters.to_date },
		];
		fields.forEach((df) => {
			if (df.fieldname === "delivery_plan" && !this.canUseDeliveryPlan) return;
			const holder = $('<div class="jce-q-filter"></div>').appendTo(toolbar);
			const control = frappe.ui.form.make_control({ parent: holder, df, render_input: true });
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				const value = control.get_value() || "";
				if ((this.oqcFilters[df.fieldname] || "") === value) return;
				this.oqcFilters[df.fieldname] = value;
				if (df.fieldname === "source_type") {
					this.oqcFilters.delivery_note = "";
					this.normalize_oqc_filters();
					this.sync_oqc_controls();
				}
				if (df.fieldname === "delivery_plan") {
					this.oqcFilters.delivery_note = "";
					this.oqcControls.delivery_note?.set_value("");
				}
				if (df.fieldname === "delivery_note") {
					this.select_oqc_delivery_note(control.get_value(), { refreshList: true });
				} else {
					this.store_oqc_filters();
					this.update_oqc_filter_visibility();
					this.schedule_oqc_refresh();
				}
			});
			this.oqcControls[df.fieldname] = control;
		});
		this.update_oqc_filter_visibility();
	}

	sync_oqc_controls() {
		Object.entries(this.oqcControls || {}).forEach(([fieldname, control]) => {
			control.set_value(this.oqcFilters[fieldname] || "");
		});
		this.update_oqc_filter_visibility();
	}

	update_oqc_filter_visibility() {
		const sourceType = this.oqcFilters.source_type || "Delivery Note";
		this.oqcControls.delivery_plan?.$wrapper.toggle(this.canUseDeliveryPlan && sourceType === "Delivery Plan");
	}

	schedule_oqc_refresh(delay = 180) {
		clearTimeout(this.oqcRefreshTimer);
		this.oqcRefreshTimer = setTimeout(() => {
			this.oqcRefreshTimer = null;
			if (this.mode === "oqc") {
				this.refresh_oqc_delivery_notes();
			}
		}, delay);
	}

	refresh_oqc_delivery_notes() {
		clearTimeout(this.oqcRefreshTimer);
		this.oqcRefreshTimer = null;
		this.normalize_oqc_filters();
		this.store_oqc_filters();
		const requestId = ++this.oqcRequestId;
		this.oqcItemsRequestId++;
		const filters = { ...this.oqcFilters };
		this.render_oqc_delivery_loading();
		if (filters.source_type === "Delivery Plan" && !filters.delivery_plan) {
			this.oqcDeliveryNotes = [];
			this.render_oqc_delivery_notes([]);
			this.render_oqc_items_empty(__("Select Delivery Plan."));
			return Promise.resolve();
		}
		this.body.find(".jce-q-oqc-items-panel .jce-q-section-head b").text(
			filters.delivery_note || filters.delivery_plan || __("Select Delivery Note.")
		);
		return frappe.call({
			method: "jce_quality.api.quality.get_delivery_oqc_delivery_notes",
			args: {
				from_date: filters.from_date,
				to_date: filters.to_date,
				customer: filters.customer,
				delivery_note: filters.delivery_note,
				delivery_plan: filters.source_type === "Delivery Plan" ? filters.delivery_plan : "",
			},
			freeze: true,
			freeze_message: __("Loading Delivery Notes..."),
		}).then((r) => {
			if (requestId !== this.oqcRequestId || this.mode !== "oqc") return;
			this.oqcDeliveryNotes = r.message || [];
			this.render_oqc_delivery_notes(this.oqcDeliveryNotes);
			if (filters.delivery_note) {
				return this.load_oqc_items(filters.delivery_note);
			}
			if (filters.source_type === "Delivery Plan" && filters.delivery_plan) {
				return this.load_delivery_plan_oqc_items(filters.delivery_plan);
			}
			this.render_oqc_items_empty(__("Select Delivery Note."));
		}).catch((error) => {
			if (requestId !== this.oqcRequestId || this.mode !== "oqc") return;
			console.error(error);
			this.body.find(".jce-q-oqc-delivery-list").html(`<div class="jce-q-empty compact">${__("Unable to load Delivery Notes.")}</div>`);
		});
	}

	render_oqc_delivery_loading() {
		this.body.find(".jce-q-oqc-count").text("...");
		this.body.find(".jce-q-oqc-delivery-list").html(`<div class="jce-q-empty compact">${__("Loading...")}</div>`);
	}

	render_oqc_delivery_notes(rows) {
		this.body.find(".jce-q-oqc-count").text(rows.length);
		const list = this.body.find(".jce-q-oqc-delivery-list");
		if (!rows.length) {
			const message = this.oqcFilters.source_type === "Delivery Plan" && this.oqcFilters.delivery_plan
				? __("No Delivery Notes linked. Showing Delivery Plan items.")
				: __("No Delivery Notes found.");
			list.html(`<div class="jce-q-empty compact">${message}</div>`);
			return;
		}
		list.html(rows.map((row) => {
			const active = row.name === this.oqcFilters.delivery_note ? "active" : "";
			return `
				<button class="jce-q-oqc-row jce-q-oqc-delivery-row ${active}" data-delivery-note="${esc(row.name || "")}">
					<div>
						<b>${esc(row.name || "")}</b>
						<span>${esc(row.customer || "-")}</span>
						<em>${esc(row.posting_date || "-")} · ${esc(row.status || "-")}</em>
					</div>
					<span class="jce-q-pill">${esc(row.company || "-")}</span>
				</button>
			`;
		}).join(""));
		list.find("[data-delivery-note]").on("click", (event) => {
			this.select_oqc_delivery_note(event.currentTarget.dataset.deliveryNote);
		});
	}

	select_oqc_delivery_note(deliveryNote, options = {}) {
		this.oqcFilters.delivery_note = deliveryNote || "";
		this.oqcControls.delivery_note?.set_value(this.oqcFilters.delivery_note);
		this.store_oqc_filters();
		this.render_oqc_delivery_notes(this.oqcDeliveryNotes || []);
		this.body.find(".jce-q-oqc-items-panel .jce-q-section-head b").text(this.oqcFilters.delivery_note || __("Select Delivery Note."));
		if (!this.oqcFilters.delivery_note) {
			if (this.oqcFilters.source_type === "Delivery Plan" && this.oqcFilters.delivery_plan) {
				this.body.find(".jce-q-oqc-items-panel .jce-q-section-head b").text(this.oqcFilters.delivery_plan);
				if (options.refreshList) {
					this.refresh_oqc_delivery_notes();
					return;
				}
				this.load_delivery_plan_oqc_items(this.oqcFilters.delivery_plan);
			} else {
				this.render_oqc_items_empty(__("Select Delivery Note."));
			}
			if (options.refreshList) this.refresh_oqc_delivery_notes();
			return;
		}
		if (options.refreshList) {
			this.refresh_oqc_delivery_notes();
			return;
		}
		this.load_oqc_items(this.oqcFilters.delivery_note);
	}

	load_oqc_items(deliveryNote) {
		const requestId = ++this.oqcItemsRequestId;
		const expectedDeliveryNote = deliveryNote || "";
		this.body.find(".jce-q-oqc-items").html(`<div class="jce-q-empty compact">${__("Loading...")}</div>`);
		return frappe.call({
			method: "jce_quality.api.quality.get_delivery_oqc_items",
			args: { delivery_note: deliveryNote },
			freeze: true,
			freeze_message: __("Loading OQC Items..."),
		}).then((r) => {
			if (requestId !== this.oqcItemsRequestId || this.mode !== "oqc" || (this.oqcFilters.delivery_note || "") !== expectedDeliveryNote) return;
			this.oqcItems = r.message || [];
			this.render_oqc_items(this.oqcItems);
		}).catch((error) => {
			if (requestId !== this.oqcItemsRequestId || this.mode !== "oqc") return;
			console.error(error);
			this.render_oqc_items_empty(__("Unable to load OQC Items."));
		});
	}

	load_delivery_plan_oqc_items(deliveryPlan) {
		const requestId = ++this.oqcItemsRequestId;
		const expectedDeliveryPlan = deliveryPlan || "";
		this.body.find(".jce-q-oqc-items-panel .jce-q-section-head b").text(deliveryPlan || __("Select Delivery Plan."));
		this.body.find(".jce-q-oqc-items").html(`<div class="jce-q-empty compact">${__("Loading...")}</div>`);
		return frappe.call({
			method: "jce_quality.api.quality.get_delivery_plan_oqc_items",
			args: { delivery_plan: deliveryPlan },
			freeze: true,
			freeze_message: __("Loading OQC Items..."),
		}).then((r) => {
			if (
				requestId !== this.oqcItemsRequestId
				|| this.mode !== "oqc"
				|| this.oqcFilters.source_type !== "Delivery Plan"
				|| (this.oqcFilters.delivery_plan || "") !== expectedDeliveryPlan
				|| this.oqcFilters.delivery_note
			) return;
			this.oqcItems = r.message || [];
			this.render_oqc_items(this.oqcItems);
		}).catch((error) => {
			if (requestId !== this.oqcItemsRequestId || this.mode !== "oqc") return;
			console.error(error);
			this.render_oqc_items_empty(__("Unable to load OQC Items."));
		});
	}

	render_oqc_items_empty(message) {
		this.body.find(".jce-q-oqc-items").html(`<div class="jce-q-empty compact">${esc(message)}</div>`);
	}

	render_oqc_items(rows) {
		const holder = this.body.find(".jce-q-oqc-items");
		if (!rows.length) {
			holder.html(`<div class="jce-q-empty compact">${__("No Delivery Note items found.")}</div>`);
			return;
		}
		holder.html(`
			<div class="jce-q-oqc-list">
				${rows.map((row) => this.render_oqc_item_row(row)).join("")}
			</div>
		`);
		holder.find("[data-oqc-open]").on("click", (event) => {
			const button = $(event.currentTarget);
			this.open_terminal_oqc_check({
				source_type: button.data("sourceType") || "Delivery Note OQC",
				delivery_note: button.data("deliveryNote") || this.oqcFilters.delivery_note,
				delivery_plan: button.data("deliveryPlan") || this.oqcFilters.delivery_plan,
				source_detail: button.data("sourceDetail") || "",
				item_code: button.data("itemCode"),
				warehouse: button.data("warehouse") || "",
				uom: button.data("uom") || "",
			});
		});
	}

	render_oqc_item_row(row) {
		const hasCheck = !!row.check_name;
		const sourceType = row.source_type || (row.delivery_plan ? "Delivery Plan OQC" : "Delivery Note OQC");
		const customerCode = clean_value(row.customer_code);
		const ruleNote = row.production_quality_rule
			? `<em>${esc(row.production_quality_rule)}${row.quality_inspection_template ? ` · ${esc(row.quality_inspection_template)}` : ""}</em>`
			: `<em class="warn">${__("No OQC rule configured. Manual inspection is allowed.")}</em>`;
		return `
			<div class="jce-q-oqc-row jce-q-oqc-item-row">
				<div class="jce-q-oqc-item-main">
					<b>${esc(row.item_code || "")}</b>
					<span>${esc(row.item_name || "")}</span>
					${customerCode ? `<span class="jce-q-oqc-customer-code">${__("Customer Code")}: ${esc(customerCode)}</span>` : ""}
					<em>${esc(row.warehouse || "-")} · ${esc(row.uom || "-")} · ${format_float(row.qty || 0)}</em>
					${ruleNote}
				</div>
				<div class="jce-q-oqc-item-actions">
					<span class="jce-q-pill">${esc(row.check_name || "-")}</span>
					<span class="jce-q-pill ${status_tone(row.overall_status)}">${esc(inspection_status_label(row.overall_status || "Pending"))}</span>
					<span class="jce-q-pill ${release_tone(row.release_status)}">${esc(oqc_release_status_label(row.release_status || "Pending"))}</span>
					<button class="jce-q-small-button primary" data-oqc-open="1" data-source-type="${esc(sourceType)}" data-delivery-note="${esc(row.delivery_note || "")}" data-delivery-plan="${esc(row.delivery_plan || "")}" data-source-detail="${esc(row.source_detail || "")}" data-item-code="${esc(row.item_code || "")}" data-warehouse="${esc(row.warehouse || "")}" data-uom="${esc(row.uom || "")}">
						${hasCheck ? __("Open OQC") : __("Create OQC")}
					</button>
				</div>
			</div>
		`;
	}

	open_terminal_oqc_check(args) {
		const isDeliveryPlanOqc = args.source_type === "Delivery Plan OQC";
		const method = isDeliveryPlanOqc
			? "jce_quality.api.quality.get_or_create_delivery_plan_oqc_check"
			: "jce_quality.api.quality.get_or_create_delivery_oqc_check";
		const callArgs = isDeliveryPlanOqc
			? { delivery_plan: args.delivery_plan, source_detail: args.source_detail }
			: {
				delivery_note: args.delivery_note,
				item_code: args.item_code,
				warehouse: args.warehouse,
				uom: args.uom,
			};
		frappe.call({
			method,
			args: callArgs,
			freeze: true,
			freeze_message: __("Opening OQC..."),
		}).then((r) => {
			if (!r.message?.name) return;
			this.selectedTask = null;
			this.current = r.message;
			this.enter_focus_mode();
		});
	}

	switch_patrol_history(direction) {
		const history = this.current?.patrol_history || [];
		if (!history.length) return;
		const current_index = history.findIndex((row) => row.name === this.current.name);
		const target = history[current_index + direction];
		if (!target?.name) return;
		this.open_check_by_name(target.name, this.selectedTask);
	}

	open_patrol_history_sheet() {
		const history = this.current?.patrol_history || [];
		if (!history.length) return;
		this.open_terminal_sheet({
			title: __("Patrol History"),
			body: `
				<div class="jce-q-patrol-history-list">
					${history.map((row) => this.render_patrol_history_row(row)).join("")}
				</div>
			`,
			on_action: (check_name) => {
				this.close_terminal_sheet();
				this.open_check_by_name(check_name, this.selectedTask);
			},
		});
	}

	render_patrol_history_row(row) {
		const is_current = row.name === this.current?.name;
		const tone = row.overall_status === "Rejected"
			? "danger"
			: row.disposition_state === "Temporary Continue"
				? "warn"
				: row.overall_status === "Accepted" || row.overall_status === "Concession Released"
					? "ok"
					: "";
		const when = row.inspection_finished_at || row.inspection_started_at || row.creation || row.modified;
		return `
			<button type="button" class="jce-q-patrol-history-row ${tone} ${is_current ? "active" : ""}" data-sheet-action="${esc(row.name)}">
				<span>${__("Patrol {0}", [cint(row.sequence_no) || "-"])}</span>
				<b>${esc(inspection_status_label(row.overall_status || row.status || "Pending"))}</b>
				<em>${esc(format_display_datetime(when))}</em>
				<small>${esc(clean_value(row.defect_summary) || __(row.disposition_state || row.status || "Pending"))}</small>
			</button>
		`;
	}

	enter_focus_mode() {
		if (this.mode !== "focus") {
			this.returnMode = this.mode || "task-list";
		}
		this.mode = "focus";
		this.drawerOpen = false;
		this.activePane = "inspection";
		this.drawingHidden = false;
		this.body.addClass("jce-terminal-focus");
		this.update_fullscreen_class(true);
		this.render_focus_shell();
	}

	exit_focus_mode() {
		this.current = null;
		if (this.returnMode === "oqc") {
			this.render_oqc_terminal_view({ refresh: true });
			return;
		}
		this.render_task_list_view();
		this.refresh();
	}

	render_focus_shell() {
		const doc = this.current;
		const submitted = cint(doc.docstatus) > 0;
		this.body.css("--drawing-width", `${this.drawingWidth}%`);
		this.body.html(`
			<div class="jce-q-focus-shell ${this.fullscreenActive ? "fullscreen" : ""}">
				${this.render_focus_toolbar(doc, submitted)}
				<div class="jce-q-mobile-tabs ${this.drawingHidden ? "single" : ""}">
					<button class="${this.activePane === "inspection" ? "active" : ""}" data-pane="inspection">${__("Inspection")}</button>
					${this.drawingHidden ? "" : `<button class="${this.activePane === "drawing" ? "active" : ""}" data-pane="drawing">${__("Drawing")}</button>`}
				</div>
				<div class="jce-q-workbench pane-${this.activePane} ${this.drawingHidden ? "drawing-hidden" : ""}">
					<section class="jce-q-inspection-pane">${this.render_inspection_panel(doc, submitted)}</section>
					<div class="jce-q-split-resizer" title="${__("Drag to resize drawing")}"></div>
					<section class="jce-q-drawing-pane">${this.render_pdf_viewer(doc)}</section>
				</div>
				<div class="jce-q-drawer-backdrop ${this.drawerOpen ? "open" : ""}" data-action="close-drawer"></div>
				<aside class="jce-q-task-drawer ${this.drawerOpen ? "open" : ""}">
					<div class="jce-q-drawer-head">
						<b>${__("Tasks")}</b>
						<button class="jce-q-small-button icon" data-action="close-drawer" title="${__("Close")}" aria-label="${__("Close")}">${icon_html("x")}</button>
					</div>
					<div class="jce-q-drawer-list"></div>
				</aside>
			</div>
		`);
		this.update_fullscreen_class(true);
		this.bind_focus_events(submitted);
		this.setup_sample_control(submitted);
		this.setup_defect_controls(submitted);
		this.bind_mobile_input_focus();
		this.render_task_drawer();
		this.setup_split_resizer();
		this.render_current_drawing();
		if (!submitted && !doc.inspection_started_at) {
			frappe.call({ method: "jce_quality.api.quality.start_check", args: { check_name: doc.name } })
				.catch((error) => console.error(error));
		}
		this.maybe_auto_open_ng_actions();
	}

	render_focus_toolbar(doc, submitted) {
		const lifecycle = submitted
			? __("Submitted")
			: doc.inspection_started_at
				? __("In Progress")
				: __("Draft");
		const status_chip = `<span class="jce-q-toolbar-status ${status_tone(doc.overall_status)}">${esc(inspection_status_label(doc.overall_status))}</span>`;
		const primary_actions = !submitted
			? `<button class="jce-q-bar-button warn" data-action="mark-ng">${__("Mark NG")}</button>
				<button class="jce-q-bar-button" data-action="save">${__("Save Draft")}</button>
				<button class="jce-q-bar-button primary" data-action="submit">${__("Submit")}</button>
				${this.fullscreen_toolbar_button()}`
			: `${this.fullscreen_toolbar_button()}`;

		return `
			<header class="jce-q-focus-toolbar">
				<div class="jce-q-toolbar-left">
					<div class="jce-q-nav-buttons">
						<button class="jce-q-small-button icon" data-action="back" title="${__("Tasks")}" aria-label="${__("Tasks")}">${icon_html("chevron-left")}</button>
						<button class="jce-q-small-button icon drawer" data-action="open-drawer" title="${__("List")}" aria-label="${__("List")}">${icon_html("list")}</button>
					</div>
					<div class="jce-q-focus-title">
						<span>${esc(__(doc.quality_node || ""))} / ${esc(lifecycle)} / ${esc(doc.name || "")}</span>
						<b>${esc(doc.item_code)} ${esc(doc.item_name || "")}</b>
						<em>${__("Work Order")}: ${esc(doc.work_order || "-")} / ${__("Qty")}: ${esc(format_float(doc.scheduling_qty || 0))}</em>
					</div>
				</div>
				<div class="jce-q-toolbar-actions">
					${status_chip}
					${this.drawingHidden ? this.show_drawing_toolbar_button() : ""}
					${primary_actions}
				</div>
			</header>
		`;
	}

	fullscreen_toolbar_button() {
		const icon = this.fullscreenActive ? "minimize-2" : "maximize-2";
		const label = this.fullscreenActive ? __("Exit Full Screen") : __("Full Screen");
		return `<button class="jce-q-small-button icon jce-q-fullscreen-button" data-action="fullscreen" title="${esc(label)}" aria-label="${esc(label)}">${icon_html(icon)}</button>`;
	}

	show_drawing_toolbar_button() {
		return `<button class="jce-q-small-button icon" data-action="show-drawing" title="${__("Show Drawing")}" aria-label="${__("Show Drawing")}">${icon_html("file-text")}</button>`;
	}

	render_inspection_panel(doc, submitted) {
		const readings = this.render_readings_matrix(doc, submitted);
		const defects = this.render_defects(doc, submitted);
		const photos = this.render_photos(doc, submitted);
		const template_version = doc.template_version || doc.template_baseline?.version || "";
		const customer_code = clean_value(doc.customer_code || this.selectedTask?.customer_code);
		const sample_count = this.get_sample_count(doc);
		return `
			${doc.template_warning ? `<div class="jce-q-warning">${esc(doc.template_warning)}</div>` : ""}
			${this.render_pwa_hint()}
			${this.render_related_alert_banner(doc)}
			${this.render_quick_actions(doc)}
			${this.render_patrol_navigator(doc)}
			${this.render_ng_disposition_panel(doc)}
			${this.render_oqc_release_panel(doc)}
			${this.render_related_alerts(doc)}
			<section class="jce-q-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Production Context")}</span>
						<b>${esc(doc.workstation || "-")}</b>
					</div>
					<span class="jce-q-muted">${esc(__(doc.quality_node || ""))}</span>
				</div>
				<div class="jce-q-info-grid">
					${this.render_info_item(__("Work Order"), doc.work_order || "-")}
					${this.render_info_item(__("Qty"), format_float(doc.scheduling_qty || 0))}
					${this.render_info_item(__("Shift"), doc.shift_type || "-")}
					${this.render_info_item(__("Customer Code"), customer_code || "-")}
					${this.render_info_item(__("Plant Floor"), doc.plant_floor || "-")}
					${this.render_info_item(__("Template"), doc.quality_inspection_template || "-")}
					${this.render_info_item(__("Version"), template_version || "-")}
				</div>
			</section>
			<div class="jce-q-decision-layout">
				<section class="jce-q-panel jce-q-decision-panel">
					<div class="jce-q-section-head">
						<div>
							<span>${__("Inspection Result")}</span>
							<b>${esc(__(doc.overall_status || "Pending"))}</b>
						</div>
						<span class="jce-q-pill ${status_tone(doc.overall_status)}">${esc(__(doc.overall_status || "Pending"))}</span>
					</div>
					<div class="jce-q-result-controls">
						<label class="jce-q-switch">
							<input type="checkbox" data-field="manual_inspection" ${doc.manual_inspection ? "checked" : ""} ${submitted ? "disabled" : ""}>
							<span></span>
							<b>${__("Manual Result")}</b>
						</label>
						<label class="jce-q-field">
							<span>${__("Result")}</span>
							<select class="form-control" data-field="overall_status" ${submitted ? "disabled" : ""}>
								${["Pending", "Accepted", "Rejected"].map((value) => `<option value="${value}" ${doc.overall_status === value ? "selected" : ""}>${__(value)}</option>`).join("")}
							</select>
						</label>
					</div>
					<div class="jce-q-system-result">
						${this.render_info_item(__("System Result"), inspection_status_label(doc.system_overall_status || doc.overall_status || "Pending"))}
						${this.render_info_item(__("Sample Qty"), sample_count)}
						${this.render_info_item(__("Defect Samples"), doc.defect_sample_qty || 0)}
						${this.render_info_item(__("Defect Rate"), `${format_float(doc.defect_rate || 0)}% / ${format_float(doc.max_defect_rate || 0)}%`)}
					</div>
				</section>
				<section class="jce-q-panel jce-q-sample-panel">
					<div class="jce-q-section-head">
						<div>
							<span>${__("Reference Sample")}</span>
							<b>${esc(doc.sample_manager || "-")}</b>
						</div>
						<span class="jce-q-pill ${cint(doc.requires_sample) ? "warn" : ""}">${cint(doc.requires_sample) ? __("Required") : __("Optional")}</span>
					</div>
					<div class="jce-q-sample-table">
						<div class="jce-q-sample-control"></div>
						${this.render_sample_meta(doc)}
					</div>
				</section>
			</div>
			<section class="jce-q-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Measurements")}</span>
						<b>${esc(doc.inspection_stage || __("Readings"))}</b>
					</div>
					<div class="jce-q-section-actions">
						<span class="jce-q-muted">${cint((doc.readings || []).length)} ${__("items")} · ${sample_count} ${__("samples")}</span>
						${submitted ? "" : `<button class="jce-q-small-button icon" data-action="add-sample" title="${__("Add Sample")}" aria-label="${__("Add Sample")}">${icon_html("plus")}</button>`}
					</div>
				</div>
				<input type="hidden" data-field="inspection_sample_qty" value="${sample_count}">
				<input type="hidden" data-field="inspection_stage" value="${esc(doc.inspection_stage || "")}">
				<div class="jce-q-readings">${readings || `<div class="jce-q-empty compact">${__("No template readings. Use Manual Result before submit.")}</div>`}</div>
			</section>
			<section class="jce-q-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Nonconformance")}</span>
						<b>${__("Defects", null, "JCE Quality")}</b>
					</div>
					<div class="jce-q-section-actions">
						${submitted ? "" : `<button class="jce-q-small-button icon" data-action="add-defect" title="${__("Add Defect")}" aria-label="${__("Add Defect")}">${icon_html("plus")}</button>`}
					</div>
				</div>
				<div class="jce-q-defects">${defects}</div>
			</section>
			<section class="jce-q-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Remarks")}</span>
						<b>${__("Operator Note")}</b>
					</div>
				</div>
				<textarea class="form-control jce-q-remarks" data-field="remarks" placeholder="${__("Remarks")}" ${submitted ? "disabled" : ""}>${esc(doc.remarks || "")}</textarea>
			</section>
			<section class="jce-q-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Evidence")}</span>
						<b>${__("Defect Photos")}</b>
					</div>
					<div class="jce-q-section-actions">
						<button class="jce-q-small-button icon" data-action="attach" title="${__("Capture Photo")}" aria-label="${__("Capture Photo")}">${icon_html("camera")}</button>
					</div>
				</div>
				<div class="jce-q-photos">${photos}</div>
			</section>
		`;
	}

	render_info_item(label, value) {
		return `<div class="jce-q-info-item"><span>${esc(label)}</span><b>${esc(value || "-")}</b></div>`;
	}

	is_oqc_check(doc) {
		return !!doc && (doc.quality_node === "OQC" || OQC_SOURCE_TYPES.includes(doc.source_type));
	}

	render_sample_meta(doc) {
		const items = [
			[__("Required Type"), doc.required_sample_type || "-"],
			[__("Sample Type"), doc.sample_type || "-"],
			[__("Sample Status"), doc.sample_status || "-"],
			[__("Sample Ref"), doc.sample_ref || "-"],
		];
		return items.map(([label, value]) => this.render_info_item(label, value)).join("");
	}

	render_related_alert_banner(doc) {
		const alerts = doc.related_defect_alerts || [];
		if (!alerts.length || this.is_alert_banner_dismissed(doc)) return "";
		return `
			<div class="jce-q-alert-banner">
				<div>
					<b>${__("Quality Alert")}</b>
					<span>${__("Other inspections for this scheduled item have NG results. Check the alert details below.")}</span>
				</div>
				<button class="jce-q-small-button icon" data-action="dismiss-alert-banner" title="${__("Close")}" aria-label="${__("Close")}">${icon_html("x")}</button>
			</div>
		`;
	}

	render_pwa_hint() {
		if (!this.is_ios_device() || this.is_standalone_app() || localStorage.getItem("jce_quality_pwa_hint_dismissed") === "1") {
			return "";
		}
		return `
			<div class="jce-q-pwa-hint">
				<div>
					<b>${__("iPad Full Screen")}</b>
					<span>${__("For a toolbar-free terminal on Apple devices, add this page to the Home Screen and open it from there.")}</span>
				</div>
				<button class="jce-q-small-button icon" data-action="dismiss-pwa-hint" title="${__("Close")}" aria-label="${__("Close")}">${icon_html("x")}</button>
			</div>
		`;
	}

	dismiss_pwa_hint() {
		localStorage.setItem("jce_quality_pwa_hint_dismissed", "1");
		this.body.find(".jce-q-pwa-hint").remove();
	}

	is_ios_device() {
		return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	}

	is_standalone_app() {
		return window.navigator.standalone || window.matchMedia?.("(display-mode: standalone)")?.matches;
	}

	render_related_alerts(doc) {
		const alerts = doc.related_defect_alerts || [];
		if (!alerts.length) return "";
		return `
			<section class="jce-q-panel jce-q-alert-detail-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("Quality Alerts")}</span>
						<b>${__("NG Details")}</b>
					</div>
					<span class="jce-q-muted">${alerts.length} ${__("items")}</span>
				</div>
				<div class="jce-q-alert-list">
					${alerts.map((alert, index) => `
						<button type="button" class="jce-q-alert-row" data-alert-index="${index}">
							<span>${esc(quality_process_label(alert.quality_node))}</span>
							<b>${esc(alert.summary || "-")}</b>
						</button>
					`).join("")}
				</div>
			</section>
		`;
	}

	render_quick_actions(doc) {
		if (this.is_oqc_check(doc)) {
			return "";
		}
		if (doc.overall_status !== "Rejected") {
			return "";
		}
		return `
			<section class="jce-q-panel jce-q-quick-actions">
				<div class="jce-q-section-head">
					<div>
						<span>${__("NG Follow-up")}</span>
						<b>${__("Choose a follow-up action for this NG inspection.")}</b>
					</div>
					<div class="jce-q-section-actions">
						<button class="jce-q-small-button primary" data-action="open-ng-actions">${icon_html("alert-triangle")}<span>${__("Quick Actions")}</span></button>
					</div>
				</div>
			</section>
		`;
	}

	render_patrol_navigator(doc) {
		if (doc.quality_node !== "Patrol") return "";
		const history = doc.patrol_history || [];
		const sequence_no = cint(doc.patrol_sequence_no) || Math.max(1, history.findIndex((row) => row.name === doc.name) + 1);
		const required_count = cint(doc.patrol_required_count) || Math.max(sequence_no, 1);
		const current_index = history.findIndex((row) => row.name === doc.name);
		const prev = current_index > 0 ? history[current_index - 1] : null;
		const next = current_index >= 0 && current_index < history.length - 1 ? history[current_index + 1] : null;
		return `
			<section class="jce-q-panel jce-q-patrol-nav">
				<div class="jce-q-patrol-nav-main">
					<div>
						<span>${__("Patrol Inspection")}</span>
						<b>${__("Patrol {0} / {1}", [sequence_no, required_count])}</b>
					</div>
					<div class="jce-q-patrol-nav-actions">
						<button class="jce-q-small-button icon" data-action="patrol-prev" ${prev ? "" : "disabled"} title="${__("Previous Patrol")}" aria-label="${__("Previous Patrol")}">${icon_html("chevron-left")}</button>
						<button class="jce-q-small-button icon" data-action="patrol-history" title="${__("Patrol History")}" aria-label="${__("Patrol History")}">${icon_html("list")}</button>
						<button class="jce-q-small-button icon" data-action="patrol-next" ${next ? "" : "disabled"} title="${__("Next Patrol")}" aria-label="${__("Next Patrol")}">${icon_html("chevron-right")}</button>
					</div>
				</div>
				<div class="jce-q-patrol-nav-meta">
					<span>${__("Passed Patrol")}: ${cint(doc.patrol_accepted_count ?? this.selectedTask?.patrol_count)} / ${required_count}</span>
					<span>${__("History")}: ${history.length} ${__("items")}</span>
				</div>
			</section>
		`;
	}

	render_ng_disposition_panel(doc) {
		if (this.is_oqc_check(doc)) {
			return "";
		}
		const should_show = doc.overall_status === "Rejected" || doc.overall_status === "Concession Released" || doc.disposition || cint(doc.release_approved);
		if (!should_show) return "";
		const state = this.get_ng_disposition_state(doc);
		const production_state = doc.overall_status === "Concession Released"
			? __("Released")
			: doc.disposition === "Temporary Continue"
				? __("Production May Continue")
				: __("Production Hold");
		const gate_state = doc.overall_status === "Concession Released"
			? __("Final Gate Passed")
			: __("Final Gate Blocked");
		const actions = this.render_disposition_actions(doc);
		return `
			<section class="jce-q-panel jce-q-disposition-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("NG Disposition Tracking")}</span>
						<b>${esc(__(state))}</b>
					</div>
					<span class="jce-q-pill ${doc.disposition === "Temporary Continue" ? "warn" : doc.overall_status === "Concession Released" ? "ok" : "danger"}">${esc(production_state)}</span>
				</div>
				<div class="jce-q-disposition-grid">
					${this.render_info_item(__("Production Status"), production_state)}
					${this.render_info_item(__("Quality Gate"), gate_state)}
					${this.render_info_item(__("Disposition"), doc.disposition ? __(doc.disposition) : __("Pending Disposition"))}
					${this.render_info_item(__("Disposition By"), doc.disposition_by || "-")}
					${this.render_info_item(__("Disposition At"), format_display_datetime(doc.disposition_at))}
					${this.render_info_item(__("Concession Approval"), cint(doc.release_approved) ? __("Approved") : __("Not Approved"))}
				</div>
				${doc.disposition_remarks ? `<div class="jce-q-disposition-note"><span>${__("Disposition Remarks")}</span><b>${esc(doc.disposition_remarks)}</b></div>` : ""}
				${actions}
			</section>
		`;
	}

	get_ng_disposition_state(doc) {
		if (doc.overall_status === "Concession Released") return "Concession Released";
		if (doc.disposition === "Temporary Continue") return "Temporary Continue";
		if (doc.disposition === "Concession Release") return cint(doc.release_approved) ? "Concession Released" : "Pending Concession Approval";
		if (["Stop Production", "Rework", "Scrap"].includes(doc.disposition)) return doc.disposition;
		if (doc.overall_status === "Rejected") return "Pending Disposition";
		return doc.overall_status || "Pending";
	}

	render_disposition_actions(doc) {
		if (doc.overall_status !== "Rejected") return "";
		const permissions = doc.terminal_permissions || {};
		const buttons = [`<button class="jce-q-bar-button" data-action="add-note">${__("Add Note")}</button>`];
		const can_temporary_continue = permissions.can_temporary_continue && (!doc.disposition || doc.disposition === "Temporary Continue" || permissions.can_disposition);
		if (can_temporary_continue) {
			buttons.push(`<button class="jce-q-bar-button warn" data-action="set-disposition" data-disposition="Temporary Continue">${__("Temporary Continue")}</button>`);
		}
		if (permissions.can_disposition) {
			[
				["Stop Production", __("Stop Production")],
				["Rework", __("Rework")],
				["Scrap", __("Scrap")],
				["Concession Release", __("Request Concession")],
			].forEach(([value, label]) => {
				buttons.push(`<button class="jce-q-bar-button" data-action="set-disposition" data-disposition="${esc(value)}">${esc(label)}</button>`);
			});
		}
		if (permissions.can_approve_concession && doc.disposition === "Concession Release" && !cint(doc.release_approved)) {
			buttons.push(`<button class="jce-q-bar-button primary" data-action="approve-concession">${__("Approve Concession")}</button>`);
		}
		if (!buttons.length) {
			return `<div class="jce-q-disposition-help">${__("Waiting for an authorized user to record disposition.")}</div>`;
		}
		return `<div class="jce-q-disposition-actions">${buttons.join("")}</div>`;
	}

	render_oqc_release_panel(doc) {
		if (!this.is_oqc_check(doc)) return "";
		const status = doc.release_status || "Pending";
		const permissions = doc.terminal_permissions || {};
		const submitted = cint(doc.docstatus) === 1;
		const sourceSubmitted = doc.oqc_source_submitted !== false;
		const passing = ["Accepted", "Concession Released"].includes(doc.overall_status);
		const rejected = doc.overall_status === "Rejected";
		const buttons = [];
		if (submitted && sourceSubmitted && passing && permissions.can_oqc_release) {
			buttons.push(`<button class="jce-q-bar-button primary" data-action="oqc-release" data-release-status="Released">${__("Release")}</button>`);
		}
		if (submitted && sourceSubmitted && passing && permissions.can_oqc_temporary_release) {
			buttons.push(`<button class="jce-q-bar-button warn" data-action="oqc-release" data-release-status="Temporary Released">${__("Temporary Release")}</button>`);
		}
		if (submitted && sourceSubmitted && rejected && permissions.can_oqc_block) {
			buttons.push(`<button class="jce-q-bar-button danger" data-action="oqc-release" data-release-status="Blocked">${__("Block")}</button>`);
		}
		const help = !submitted
			? __("Submit the OQC check before release.")
			: !sourceSubmitted
				? __("Submit the Delivery Note before final OQC release actions.")
				: rejected
				? __("Rejected OQC can be blocked or escalated by an authorized user.")
				: passing
					? __("Waiting for an authorized user to release OQC.")
					: __("OQC release is available after accepted inspection.");
		const sourceLabel = doc.source_doctype || __("Source");
		return `
			<section class="jce-q-panel jce-q-disposition-panel">
				<div class="jce-q-section-head">
					<div>
						<span>${__("OQC Release")}</span>
						<b>${esc(oqc_release_status_label(status))}</b>
					</div>
					<span class="jce-q-pill ${status === "Released" ? "ok" : status === "Blocked" ? "danger" : "warn"}">${esc(oqc_release_status_label(status))}</span>
				</div>
				<div class="jce-q-info-grid">
					${this.render_info_item(__(sourceLabel), doc.source_name || "-")}
					${this.render_info_item(__("Source Status"), doc.oqc_source_status || doc.oqc_source_docstatus || "-")}
					${this.render_info_item(__("Source Detail"), doc.source_detail || "-")}
					${this.render_info_item(__("Escalated DMR"), doc.escalated_dmr || "-")}
				</div>
				${doc.temporary_release_note ? `<div class="jce-q-disposition-note"><span>${__("Temporary Release Note")}</span><b>${esc(doc.temporary_release_note)}</b></div>` : ""}
				${buttons.length ? `<div class="jce-q-disposition-actions">${buttons.join("")}</div>` : `<div class="jce-q-disposition-help">${help}</div>`}
			</section>
		`;
	}

	render_pdf_viewer(doc) {
		const drawing = this.get_drawing_url(doc);
		if (!drawing) {
			return `<div class="jce-q-drawing-empty">${__("No drawing file linked.")}</div>`;
		}
		const is_pdf = this.is_pdf(drawing);
		const state = this.get_drawing_state(drawing);
		if (!is_pdf) {
			return `
				<div class="jce-q-drawing-toolbar">
					<div class="jce-q-drawing-title">
						<span>${__("Drawing")}</span>
						<b>${esc(doc.item_code || doc.quality_inspection_template || "")}</b>
					</div>
					<div class="jce-q-drawing-actions">
						<div class="jce-q-button-group">
							${this.icon_button("data-drawing-action", "zoom-out", "zoom-out", __("Zoom Out"))}
							<span>${state.zoom}%</span>
							${this.icon_button("data-drawing-action", "zoom-in", "zoom-in", __("Zoom In"))}
						</div>
						${this.icon_link(drawing, "external-link", __("Open", null, "JCE Quality"))}
						${this.icon_button("data-drawing-action", "hide-drawing", "x", __("Hide Drawing"))}
					</div>
				</div>
				<div class="jce-q-image-viewer">
					<img src="${esc(drawing)}" style="width:${state.zoom}%" alt="${__("Drawing")}">
				</div>
			`;
		}
		return `
			<div class="jce-q-drawing-toolbar">
				<div class="jce-q-drawing-title">
					<span>${__("Drawing")}</span>
					<b>${esc(doc.item_code || doc.quality_inspection_template || "")}</b>
					</div>
					<div class="jce-q-drawing-actions">
						<div class="jce-q-button-group">
							${this.icon_button("data-pdf-action", "prev", "chevron-left", __("Prev"))}
							<span class="jce-q-page-count">${state.page || 1} / ${state.totalPages || "-"}</span>
							${this.icon_button("data-pdf-action", "next", "chevron-right", __("Next"))}
						</div>
						<div class="jce-q-button-group">
							${this.icon_button("data-pdf-action", "zoom-out", "zoom-out", __("Zoom Out"))}
							<span class="jce-q-scale">${Math.round((state.scale || 1) * 100)}%</span>
							${this.icon_button("data-pdf-action", "zoom-in", "zoom-in", __("Zoom In"))}
						</div>
						<div class="jce-q-button-group">
							${this.icon_button("data-pdf-action", "fit-width", "move-horizontal", __("Fit Width"))}
							${this.icon_button("data-pdf-action", "fit-page", "maximize-2", __("Fit Page"))}
						</div>
						${this.icon_link(drawing, "external-link", __("Open", null, "JCE Quality"))}
						${this.icon_button("data-drawing-action", "hide-drawing", "x", __("Hide Drawing"))}
				</div>
			</div>
			<div class="jce-q-pdf-stage">
				<div class="jce-q-pdf-loading">${__("Loading drawing...")}</div>
				<canvas class="jce-q-pdf-canvas"></canvas>
			</div>
		`;
	}

	icon_button(attribute, action, icon, label) {
		return `<button class="jce-q-small-button icon" ${attribute}="${esc(action)}" title="${esc(label)}" aria-label="${esc(label)}">${icon_html(icon)}</button>`;
	}

	icon_link(href, icon, label) {
		return `<a class="jce-q-small-button icon" href="${esc(href)}" target="_blank" rel="noreferrer" title="${esc(label)}" aria-label="${esc(label)}">${icon_html(icon)}</a>`;
	}

	bind_focus_events(submitted) {
		const shell = this.body.find(".jce-q-focus-shell");
		shell.find('[data-action="back"]').on("click", () => this.exit_focus_mode());
		shell.find('[data-action="open-drawer"]').on("click", () => this.open_drawer());
		shell.find('[data-action="close-drawer"]').on("click", () => this.close_drawer());
		shell.find('[data-action="start"]').on("click", () => this.start_check());
		shell.find('[data-action="save"]').on("click", () => this.save_check(false));
		shell.find('[data-action="submit"]').on("click", () => this.save_check(true));
		shell.find('[data-action="mark-ng"]').on("click", () => this.mark_ng());
		shell.find('[data-action="fullscreen"]').on("click", () => this.toggle_fullscreen());
		shell.find('[data-action="show-drawing"]').on("click", () => this.show_drawing());
		shell.find('[data-action="hide-drawing"]').on("click", () => this.hide_drawing());
		shell.find('[data-action="set-disposition"]').on("click", (event) => this.open_disposition_sheet(event.currentTarget.dataset.disposition));
		shell.find('[data-action="approve-concession"]').on("click", () => this.approve_concession_release());
		shell.find('[data-action="oqc-release"]').on("click", (event) => this.open_oqc_release_sheet(event.currentTarget.dataset.releaseStatus));
		shell.find('[data-action="add-note"]').on("click", () => this.open_note_sheet());
		shell.find('[data-action="patrol-prev"]').on("click", () => this.switch_patrol_history(-1));
		shell.find('[data-action="patrol-next"]').on("click", () => this.switch_patrol_history(1));
		shell.find('[data-action="patrol-history"]').on("click", () => this.open_patrol_history_sheet());
		shell.find('[data-action="attach"]').on("click", () => this.attach_photo());
		shell.find('[data-action="add-defect"]').on("click", () => this.add_defect_row());
		shell.find('[data-action="add-sample"]').on("click", () => this.add_sample_column());
		shell.find('[data-action="open-ng-actions"]').on("click", () => this.open_ng_action_dialog());
		shell.find('[data-action="dismiss-alert-banner"]').on("click", () => this.dismiss_alert_banner());
		shell.find('[data-action="dismiss-pwa-hint"]').on("click", () => this.dismiss_pwa_hint());
		shell.find('[data-action="remove-defect"]').on("click", (event) => $(event.currentTarget).closest(".jce-q-defect-row").remove());
		shell.find('[data-action="remove-photo"]').on("click", (event) => $(event.currentTarget).closest(".jce-q-photo").remove());
		shell.find("[data-alert-index]").on("click", (event) => this.show_related_alert(cint(event.currentTarget.dataset.alertIndex)));
		shell.find("[data-pane]").on("click", (event) => this.switch_pane(event.currentTarget.dataset.pane));
		shell.find("[data-pdf-action]").on("click", (event) => this.handle_pdf_action(event.currentTarget.dataset.pdfAction));
		shell.find("[data-drawing-action]").on("click", (event) => this.handle_image_action(event.currentTarget.dataset.drawingAction));
	}

	maybe_auto_open_ng_actions() {
		if (!this.current || this.current.overall_status !== "Rejected") return;
		if (this.is_oqc_check(this.current)) return;
		if (this.ngActionDialogShown.has(this.current.name)) return;
		this.ngActionDialogShown.add(this.current.name);
		setTimeout(() => this.open_ng_action_dialog({ automatic: true }), 220);
	}

	open_ng_action_dialog() {
		if (!this.current || this.current.overall_status !== "Rejected") return;
		if (this.is_oqc_check(this.current)) return;
		const action_note = this.build_action_note(this.current);
		this.open_terminal_sheet({
			title: __("NG Quick Actions"),
			body: `
				<div class="jce-q-sheet-options">
					<button data-sheet-action="warning">${icon_html("alert-triangle")}<span>${__("Schedule Warning")}</span></button>
					<button data-sheet-action="patrol" ${this.current.patrol_increase_blocked ? "disabled" : ""}>${icon_html("refresh-cw")}<span>${this.current.patrol_increase_blocked ? __("Patrol already increased") : __("Increase Patrol")}</span></button>
					<button data-sheet-action="dmr">${icon_html("file-text")}<span>${__("Create DMR")}</span></button>
				</div>
			`,
			on_action: (action) => {
				if (action === "warning") this.open_warning_sheet(action_note);
				if (action === "patrol") this.open_patrol_sheet(action_note);
				if (action === "dmr") {
					this.close_terminal_sheet();
					this.create_dmr_from_current();
				}
			},
		});
	}

	open_oqc_release_sheet(release_status) {
		if (!this.current || !release_status) return;
		const permissions = this.current.terminal_permissions || {};
		const show_note = release_status === "Temporary Released" || this.current.temporary_release_note;
		const show_dmr = this.current.overall_status === "Rejected" && cint(this.current.docstatus) && permissions.can_oqc_escalate_to_dmr;
		this.open_terminal_sheet({
			title: __(release_status),
			body: `
				${show_note ? `
					<label class="jce-q-sheet-field">
						<span>${__("Temporary Release Note")}</span>
						<textarea data-sheet-field="temporary_release_note">${esc(this.current.temporary_release_note || "")}</textarea>
					</label>
				` : ""}
				${show_dmr ? `
					<label class="jce-q-switch">
						<input type="checkbox" data-sheet-field="escalate_to_dmr">
						<span></span>
						<b>${__("Escalate to DMR")}</b>
					</label>
				` : ""}
			`,
				primary_label: __("Save"),
				on_primary: async (sheet) => {
					const temporary_release_note = sheet.find('[data-sheet-field="temporary_release_note"]').val();
					const args = {
						check_name: this.current.name,
						release_status,
						escalate_to_dmr: sheet.find('[data-sheet-field="escalate_to_dmr"]').is(":checked") ? 1 : 0,
					};
					if (temporary_release_note !== undefined) {
						args.temporary_release_note = temporary_release_note;
					}
					const r = await frappe.call({
						method: "jce_quality.api.quality.release_oqc_check",
						args,
						freeze: true,
						freeze_message: __("Saving OQC release..."),
					});
					this.current.release_status = r.message?.release_status || release_status;
					this.current.escalated_dmr = r.message?.dmr || this.current.escalated_dmr;
					this.current.temporary_release_note = temporary_release_note || this.current.temporary_release_note;
				this.close_terminal_sheet();
				this.render_focus_shell();
			},
		});
	}

	open_warning_sheet(summary) {
		this.open_terminal_sheet({
			title: __("Schedule Warning"),
			body: `
				<label class="jce-q-sheet-field">
					<span>${__("Alert Note")}</span>
					<textarea data-sheet-field="alert_note">${esc(summary || "")}</textarea>
				</label>
			`,
			primary_label: __("Save"),
			on_primary: async (sheet) => {
				const note = sheet.find('[data-sheet-field="alert_note"]').val() || summary;
				await this.trigger_defect_alert(note);
				this.close_terminal_sheet();
			},
		});
	}

	open_patrol_sheet(summary) {
		this.open_terminal_sheet({
			title: __("Increase Patrol"),
			body: `
				<label class="jce-q-sheet-field">
					<span>${__("Additional Patrol Count")}</span>
					<input data-sheet-field="increment" type="number" min="1" step="1" value="1">
				</label>
				<label class="jce-q-sheet-field">
					<span>${__("Alert Note")}</span>
					<textarea data-sheet-field="remarks">${esc(summary || "")}</textarea>
				</label>
			`,
			primary_label: __("Increase Patrol"),
			on_primary: async (sheet) => {
				const increment = Math.max(1, cint(sheet.find('[data-sheet-field="increment"]').val() || 1));
				const remarks = sheet.find('[data-sheet-field="remarks"]').val() || summary;
				await this.increase_patrol_count(increment, remarks);
				this.close_terminal_sheet();
			},
		});
	}

	open_terminal_sheet({ title, body, primary_label = "", on_primary = null, on_action = null }) {
		this.close_terminal_sheet();
		const primary = primary_label ? `<button class="jce-q-bar-button primary" data-sheet-primary="1">${esc(primary_label)}</button>` : "";
		const sheet = $(`
			<div class="jce-q-sheet-backdrop">
				<div class="jce-q-sheet" role="dialog" aria-modal="true">
					<div class="jce-q-sheet-head">
						<b>${esc(title)}</b>
						<button class="jce-q-small-button icon" data-sheet-close="1" title="${__("Close")}" aria-label="${__("Close")}">${icon_html("x")}</button>
					</div>
					<div class="jce-q-sheet-body">${body}</div>
					<div class="jce-q-sheet-foot">
						<button class="jce-q-bar-button" data-sheet-close="1">${__("Cancel")}</button>
						${primary}
					</div>
				</div>
			</div>
		`).appendTo(this.body);
		sheet.find("[data-sheet-close]").on("click", () => this.close_terminal_sheet());
		sheet.find("[data-sheet-action]").on("click", (event) => on_action?.(event.currentTarget.dataset.sheetAction, sheet));
		sheet.find("[data-sheet-primary]").on("click", async (event) => {
			$(event.currentTarget).prop("disabled", true);
			try {
				await on_primary?.(sheet);
			} catch (error) {
				$(event.currentTarget).prop("disabled", false);
				throw error;
			}
		});
		this.activeSheet = sheet;
	}

	close_terminal_sheet() {
		this.activeSheet?.remove();
		this.activeSheet = null;
	}

	build_defect_summary(doc = this.current) {
		const payload = this.current?.name === doc?.name ? this.collect_payload() : null;
		const parts = [];
		if (doc?.quality_node) parts.push(`${__("Inspection Process")}: ${quality_process_label(doc.quality_node)}`);
		if (doc?.overall_status) parts.push(`${__("Result")}: ${inspection_status_label(doc.overall_status)}`);
		if (cint(doc?.inspection_sample_qty)) {
			parts.push(`${__("Defect Rate")}: ${format_float(doc.defect_rate || 0)}% (${cint(doc.defect_sample_qty)} / ${cint(doc.inspection_sample_qty)})`);
		}
		const failed_readings = (doc?.readings || []).filter((row) => ["Rejected", "Failed"].includes(row.status));
		if (failed_readings.length) {
			parts.push(`${__("Measurements")}: ${failed_readings.slice(0, 4).map((row) => `${row.specification || row.idx}(${__(row.status || "Rejected")})`).join("; ")}`);
		}
		const defects = payload?.defects?.length ? payload.defects : (doc?.defects || []);
		if (defects.length) {
			parts.push(`${__("Defects", null, "JCE Quality")}: ${defects.slice(0, 5).map((row) => {
				let text = row.defect_name || row.defect_code || "-";
				if (row.quantity) text += ` x ${format_float(row.quantity)}`;
				if (row.remarks) text += ` - ${row.remarks}`;
				return text;
			}).join("; ")}`);
		}
		const remarks = payload?.remarks || doc?.remarks;
		if (remarks) parts.push(`${__("Remarks")}: ${remarks}`);
		return parts.filter(Boolean).join(" | ") || clean_value(doc?.defect_summary || "");
	}

	build_action_note(doc = this.current) {
		const payload = this.current?.name === doc?.name ? this.collect_payload() : null;
		const parts = [];
		const failed_samples = (doc?.sample_readings || []).filter((row) => ["Rejected", "Failed"].includes(row.status));
		if (failed_samples.length) {
			parts.push(`${__("Measurements")}: ${failed_samples.slice(0, 6).map((row) => {
				const sample = cint(row.sample_no) ? `#${cint(row.sample_no)} ` : "";
				return `${sample}${row.specification || row.idx}(NG)`;
			}).join("; ")}`);
		} else {
			const failed_readings = (doc?.readings || []).filter((row) => ["Rejected", "Failed"].includes(row.status));
			if (failed_readings.length) {
				parts.push(`${__("Measurements")}: ${failed_readings.slice(0, 6).map((row) => `${row.specification || row.idx}(NG)`).join("; ")}`);
			}
		}
		const defects = payload?.defects?.length ? payload.defects : (doc?.defects || []);
		if (defects.length) {
			parts.push(`${__("Defects", null, "JCE Quality")}: ${defects.slice(0, 6).map((row) => {
				let text = row.defect_name || row.defect_code || "-";
				if (row.quantity) text += ` x ${format_float(row.quantity)}`;
				if (row.remarks) text += ` - ${row.remarks}`;
				return text;
			}).join("; ")}`);
		}
		if (cint(doc?.inspection_sample_qty) && cint(doc?.defect_sample_qty)) {
			parts.push(`${__("Defect Rate")}: ${format_float(doc.defect_rate || 0)}% (${cint(doc.defect_sample_qty)} / ${cint(doc.inspection_sample_qty)})`);
		}
		const remarks = payload?.remarks || doc?.remarks;
		if (remarks) parts.push(`${__("Remarks")}: ${remarks}`);
		return parts.filter(Boolean).join(" | ") || __("Rejected inspection needs follow-up.");
	}

	show_related_alert(index) {
		const alert = (this.current?.related_defect_alerts || [])[index];
		if (!alert) return;
		const defects = (alert.defects || []).map((row) => `
			<tr>
				<td>${esc(row.defect_code || "-")}</td>
				<td>${esc(row.defect_name || "-")}</td>
				<td>${esc(format_float(row.quantity || 0))}</td>
				<td>${esc(row.remarks || "-")}</td>
			</tr>
		`).join("");
		const readings = (alert.failed_readings || []).map((row) => `
			<tr>
				<td>${esc(row.sample_no ? `${__("Sample")} ${row.sample_no}` : "-")}</td>
				<td>${esc(row.specification || row.idx || "-")}</td>
				<td>${esc(__(row.status || "Rejected"))}</td>
				<td>${esc(row.reading_value || "-")}</td>
			</tr>
		`).join("");
		const d = new frappe.ui.Dialog({
			title: `${__("Quality Alert")} - ${quality_process_label(alert.quality_node)}`,
			size: "large",
			fields: [{
				fieldtype: "HTML",
				fieldname: "detail",
				options: `
					<div class="jce-q-alert-dialog">
						<div class="jce-q-dialog-summary">${esc(alert.summary || "-")}</div>
						${defects ? `<h5>${__("Defects", null, "JCE Quality")}</h5><table class="table table-bordered"><thead><tr><th>${__("Defect Code", null, "JCE Quality")}</th><th>${__("Defect Name")}</th><th>${__("Quantity")}</th><th>${__("Remarks")}</th></tr></thead><tbody>${defects}</tbody></table>` : ""}
						${readings ? `<h5>${__("Measurements")}</h5><table class="table table-bordered"><thead><tr><th>${__("Sample")}</th><th>${__("Specification")}</th><th>${__("Status")}</th><th>${__("Value")}</th></tr></thead><tbody>${readings}</tbody></table>` : ""}
						${alert.remarks ? `<h5>${__("Remarks")}</h5><p>${esc(alert.remarks)}</p>` : ""}
					</div>
				`,
			}],
			primary_action_label: __("Open Form"),
			primary_action: () => frappe.set_route("Form", "Production Quality Check", alert.name),
		});
		d.show();
	}

	is_alert_banner_dismissed(doc = this.current) {
		return localStorage.getItem(this.alert_banner_key(doc)) === "1";
	}

	dismiss_alert_banner() {
		localStorage.setItem(this.alert_banner_key(), "1");
		this.body.find(".jce-q-alert-banner").remove();
	}

	alert_banner_key(doc = this.current) {
		const alerts = doc?.related_defect_alerts || [];
		const signature = alerts.length
			? alerts.map((row) => `${row.name}:${row.modified || ""}:${row.summary || ""}`).join("|")
			: [doc?.scheduling_alert_source_check, doc?.scheduling_alert_note].filter(Boolean).join("|");
		return `jce_quality_alert_banner_${doc?.scheduling_item || doc?.name || "terminal"}_${stable_key_hash(signature || "none")}`;
	}

	setup_sample_control(submitted) {
		const holder = this.body.find(".jce-q-sample-control");
		if (!holder.length) return;
		holder.empty();
		this.sampleControl = null;
		const sample_manager = this.current.sample_manager || "";
		if (submitted) {
			holder.html(`<div class="jce-q-readonly-link">${esc(sample_manager || "-")}</div>`);
			return;
		}
		if (!document.body.contains(holder.get(0))) {
			return;
		}
		try {
			this.sampleControl = frappe.ui.form.make_control({
				parent: holder,
				df: {
					fieldname: "sample_manager",
					fieldtype: "Link",
					label: __("Reference Sample"),
					options: "Sample Manager",
				},
				render_input: true,
			});
			this.sampleControl.set_value(sample_manager);
		} catch (error) {
			console.error(error);
			holder.html(
				`<input class="form-control" data-field="sample_manager" value="${esc(sample_manager)}" placeholder="${__("Reference Sample")}">`
			);
		}
	}

	setup_defect_controls(submitted, scope = null) {
		const root = scope ? $(scope) : this.body;
		root.find(".jce-q-defect-control").each((_, node) => {
			const holder = $(node);
			if (holder.data("control")) return;
			const row = holder.closest(".jce-q-defect-row");
			const hidden = row.find('[data-field="defect_code"]');
			const value = holder.data("value") || hidden.val() || "";
			const description = row.find(".jce-q-defect-description");
			const control = frappe.ui.form.make_control({
				parent: holder,
				df: {
					fieldname: `defect_code_${++this.defectControlCounter}`,
					fieldtype: "Link",
					label: __("Defect Code", null, "JCE Quality"),
					options: "Quality Defect Code",
					read_only: submitted ? 1 : 0,
					get_query: () => ({ filters: { disabled: 0 } }),
				},
				render_input: true,
			});
			control.set_value(value);
			hidden.val(value);
			const sync_description = () => {
				const code = control.get_value() || control.$input.val() || "";
				hidden.val(code);
				description.html(this.render_defect_description(code));
			};
			sync_description();
			control.$input?.on("change input blur awesomplete-selectcomplete", sync_description);
			holder.data("control", control);
		});
	}

	render_defect_description(defect_code) {
		const row = this.get_defect_option(defect_code);
		const text = row?.description || row?.defect_name || "";
		return text ? `<span>${esc(text)}</span>` : "";
	}

	get_defect_option(defect_code) {
		if (!defect_code) return null;
		return (this.defect_options || []).find((row) => row.defect_code === defect_code || row.name === defect_code);
	}

	render_task_drawer() {
		const list = this.body.find(".jce-q-drawer-list");
		if (!list.length) return;
		this.render_tasks(list);
	}

	open_drawer() {
		this.drawerOpen = true;
		this.body.find(".jce-q-task-drawer, .jce-q-drawer-backdrop").addClass("open");
		this.render_task_drawer();
	}

	close_drawer() {
		this.drawerOpen = false;
		this.body.find(".jce-q-task-drawer, .jce-q-drawer-backdrop").removeClass("open");
	}

	switch_pane(pane) {
		if (pane === "drawing" && this.drawingHidden) return;
		this.activePane = pane;
		this.body.find(".jce-q-workbench").removeClass("pane-inspection pane-drawing").addClass(`pane-${pane}`);
		this.body.find("[data-pane]").removeClass("active");
		this.body.find(`[data-pane="${pane}"]`).addClass("active");
		if (pane === "drawing") {
			this.render_current_drawing();
		}
	}

	hide_drawing() {
		this.drawingHidden = true;
		this.activePane = "inspection";
		this.render_focus_shell();
	}

	show_drawing() {
		this.drawingHidden = false;
		this.render_focus_shell();
	}

	bind_mobile_input_focus() {
		const selector = [
			".jce-q-filter input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([disabled])",
			".jce-q-inspection-pane input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([disabled])",
			".jce-q-sheet input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([disabled])",
			".jce-q-terminal textarea:not([disabled])",
		].join(", ");
		this.body
			.off("touchend.jceMobileInputFocus", selector)
			.on("touchend.jceMobileInputFocus", selector, (event) => {
				if (!this.is_phone_portrait()) return;
				const input = event.currentTarget;
				const type = (input.getAttribute("type") || "text").toLowerCase();
				if (["button", "color", "date", "datetime-local", "file", "month", "reset", "submit", "time", "week"].includes(type)) {
					return;
				}
				if (document.activeElement === input) return;
				try {
					input.focus({ preventScroll: true });
				} catch {
					input.focus();
				}
			});
	}

	is_phone_portrait() {
		return !!window.matchMedia?.("(max-width: 640px) and (orientation: portrait)")?.matches;
	}

	bind_fullscreen_change() {
		if (this.fullscreenChangeHandler) return;
		this.fullscreenChangeHandler = () => {
			const nativeElement = document.fullscreenElement || document.webkitFullscreenElement;
			if (!nativeElement && this.nativeFullscreenRequested) {
				this.fullscreenActive = false;
				this.nativeFullscreenRequested = false;
				this.update_fullscreen_class();
			}
		};
		document.addEventListener("fullscreenchange", this.fullscreenChangeHandler);
		document.addEventListener("webkitfullscreenchange", this.fullscreenChangeHandler);
	}

	toggle_fullscreen() {
		if (this.fullscreenActive) {
			this.exit_fullscreen();
		} else {
			this.enter_fullscreen();
		}
	}

	enter_fullscreen() {
		this.fullscreenActive = true;
		this.nativeFullscreenRequested = false;
		this.update_fullscreen_class();
	}

	exit_fullscreen() {
		this.fullscreenActive = false;
		this.update_fullscreen_class();
		const nativeElement = document.fullscreenElement || document.webkitFullscreenElement;
		if (!nativeElement) {
			this.nativeFullscreenRequested = false;
			return;
		}
		const exit = document.exitFullscreen || document.webkitExitFullscreen;
		if (!exit) return;
		Promise.resolve(exit.call(document)).catch((error) => console.warn(error)).finally(() => {
			this.nativeFullscreenRequested = false;
		});
	}

	update_fullscreen_class(skip_render = false) {
		this.body.toggleClass("jce-terminal-fullscreen", this.fullscreenActive);
		$("body").toggleClass("jce-quality-terminal-focus-active", this.fullscreenActive);
		$("body").toggleClass("jce-quality-terminal-fullscreen-active", this.fullscreenActive);
		this.body.find(".jce-q-focus-shell").toggleClass("fullscreen", this.fullscreenActive);
		const label = this.fullscreenActive ? __("Exit Full Screen") : __("Full Screen");
		const icon = this.fullscreenActive ? "minimize-2" : "maximize-2";
		this.body.find('[data-action="fullscreen"]')
			.attr("title", label)
			.attr("aria-label", label)
			.html(icon_html(icon));
		if (!skip_render) {
			setTimeout(() => this.render_current_drawing(), 80);
		}
	}

	setup_split_resizer() {
		const shell = this.body.find(".jce-q-focus-shell");
		const handle = shell.find(".jce-q-split-resizer");
		if (!handle.length) return;
		handle.off("pointerdown").on("pointerdown", (event) => {
			event.preventDefault();
			handle.addClass("active");
			const start_x = event.clientX;
			const start_width = this.drawingWidth;
			const total_width = shell.find(".jce-q-workbench").outerWidth();
			const on_move = (move_event) => {
				const delta_pct = ((move_event.clientX - start_x) / total_width) * 100;
				this.drawingWidth = clamp(start_width - delta_pct, 35, 70);
				this.body.css("--drawing-width", `${this.drawingWidth}%`);
				this.schedule_pdf_render();
			};
			const on_up = () => {
				handle.removeClass("active");
				localStorage.setItem(DRAWING_WIDTH_KEY, String(Math.round(this.drawingWidth)));
				$(document).off("pointermove", on_move);
				$(document).off("pointerup", on_up);
				this.render_current_drawing();
			};
			$(document).on("pointermove", on_move);
			$(document).on("pointerup", on_up);
		});
	}

	get_stored_drawing_width() {
		const value = cint(localStorage.getItem(DRAWING_WIDTH_KEY));
		return value ? clamp(value, 35, 70) : 50;
	}

	get_drawing_url(doc = this.current) {
		return clean_url(doc?.drawing_file) || clean_url(doc?.template_baseline?.drawing_file);
	}

	is_pdf(url) {
		return String(url || "").toLowerCase().split("?")[0].includes(".pdf");
	}

	get_drawing_state(drawing) {
		if (!this.drawing_state[drawing]) {
			this.drawing_state[drawing] = {
				page: 1,
				totalPages: 0,
				scale: 1,
				zoom: 100,
				fitMode: "width",
				renderToken: 0,
			};
		}
		return this.drawing_state[drawing];
	}

	load_pdfjs() {
		if (window.pdfjsLib) {
			window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
			return Promise.resolve(window.pdfjsLib);
		}
		if (this.pdfjs_promise) return this.pdfjs_promise;
		this.pdfjs_promise = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = PDFJS_SRC;
			script.onload = () => {
				window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
				resolve(window.pdfjsLib);
			};
			script.onerror = () => reject(new Error("PDF.js failed to load"));
			document.head.appendChild(script);
		});
		return this.pdfjs_promise;
	}

	render_current_drawing() {
		if (this.drawingHidden) return;
		const drawing = this.get_drawing_url();
		if (!drawing || !this.is_pdf(drawing)) return;
		this.render_pdf_canvas(drawing);
	}

	async render_pdf_canvas(drawing) {
		const stage = this.body.find(".jce-q-pdf-stage");
		const canvas = stage.find(".jce-q-pdf-canvas").get(0);
		const loading = stage.find(".jce-q-pdf-loading");
		if (!stage.length || !canvas) return;
		const state = this.get_drawing_state(drawing);
		const renderToken = ++state.renderToken;
		try {
			loading.text(__("Loading drawing...")).show();
			const pdfjsLib = await this.load_pdfjs();
			if (!state.pdfDoc) {
				state.pdfDoc = await pdfjsLib.getDocument(drawing).promise;
				state.totalPages = state.pdfDoc.numPages;
				state.page = clamp(state.page || 1, 1, state.totalPages);
				this.update_pdf_toolbar(state);
			}
			const page = await state.pdfDoc.getPage(state.page);
			if (renderToken !== state.renderToken) return;
			const container = stage.get(0);
			const baseViewport = page.getViewport({ scale: 1 });
			const availableWidth = Math.max(container.clientWidth - 20, 280);
			const availableHeight = Math.max(container.clientHeight - 20, 360);
			let scale = state.scale || 1;
			if (state.fitMode === "width") {
				scale = availableWidth / baseViewport.width;
			} else if (state.fitMode === "page") {
				scale = Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
			}
			scale = clamp(scale, 0.4, 4);
			const viewport = page.getViewport({ scale });
			const outputScale = window.devicePixelRatio || 1;
			const context = canvas.getContext("2d");
			canvas.width = Math.floor(viewport.width * outputScale);
			canvas.height = Math.floor(viewport.height * outputScale);
			canvas.style.width = `${Math.floor(viewport.width)}px`;
			canvas.style.height = `${Math.floor(viewport.height)}px`;
			context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
			await page.render({ canvasContext: context, viewport }).promise;
			if (renderToken !== state.renderToken) return;
			loading.hide();
			this.update_pdf_toolbar(state, scale);
		} catch (error) {
			console.error(error);
			loading.html(`${__("Unable to preview drawing.")} <a href="${esc(drawing)}" target="_blank" rel="noreferrer">${__("Open", null, "JCE Quality")}</a>`).show();
		}
	}

	update_pdf_toolbar(state, renderedScale = null) {
		const toolbar = this.body.find(".jce-q-drawing-toolbar");
		toolbar.find(".jce-q-page-count").text(`${state.page || 1} / ${state.totalPages || "-"}`);
		if (renderedScale) {
			toolbar.find(".jce-q-scale").text(`${Math.round(renderedScale * 100)}%`);
		}
	}

	schedule_pdf_render() {
		clearTimeout(this.pdf_resize_timer);
		this.pdf_resize_timer = setTimeout(() => this.render_current_drawing(), 120);
	}

	handle_pdf_action(action) {
		const drawing = this.get_drawing_url();
		if (!drawing) return;
		const state = this.get_drawing_state(drawing);
		if (action === "prev") state.page = Math.max(1, (state.page || 1) - 1);
		if (action === "next") state.page = Math.min(state.totalPages || 999, (state.page || 1) + 1);
		if (action === "zoom-out") {
			state.fitMode = "custom";
			state.scale = clamp((state.scale || 1) - 0.15, 0.4, 4);
		}
		if (action === "zoom-in") {
			state.fitMode = "custom";
			state.scale = clamp((state.scale || 1) + 0.15, 0.4, 4);
		}
		if (action === "fit-width") state.fitMode = "width";
		if (action === "fit-page") state.fitMode = "page";
		this.render_current_drawing();
	}

	handle_image_action(action) {
		if (action === "hide-drawing") {
			this.hide_drawing();
			return;
		}
		const drawing = this.get_drawing_url();
		if (!drawing) return;
		const state = this.get_drawing_state(drawing);
		if (action === "zoom-out") state.zoom = Math.max(40, state.zoom - 20);
		if (action === "zoom-in") state.zoom = Math.min(240, state.zoom + 20);
		this.body.find(".jce-q-drawing-pane").html(this.render_pdf_viewer(this.current));
		this.body.find("[data-drawing-action]").on("click", (event) => this.handle_image_action(event.currentTarget.dataset.drawingAction));
	}

	render_defects(doc, submitted) {
		const rows = doc.defects || [];
		if (!rows.length && submitted) {
			return `<div class="jce-q-empty compact">${__("No defects recorded.")}</div>`;
		}
		return rows.map((row) => this.defect_row(row, submitted)).join("") || `<div class="jce-q-empty compact">${__("No defects recorded.")}</div>`;
	}

	defect_row(row = {}, submitted = false) {
		return `
			<div class="jce-q-defect-row">
				<div class="jce-q-field jce-q-defect-code-field">
					<div class="jce-q-defect-control" data-value="${esc(row.defect_code || "")}"></div>
					<input type="hidden" data-field="defect_code" value="${esc(row.defect_code || "")}">
					<div class="jce-q-defect-description">${this.render_defect_description(row.defect_code) || (row.description ? `<span>${esc(row.description)}</span>` : "")}</div>
				</div>
				<label class="jce-q-field">
					<span>${__("Quantity")}</span>
					<input class="form-control" data-field="quantity" type="number" min="0" step="1" value="${esc(row.quantity || 1)}" ${submitted ? "disabled" : ""}>
				</label>
				<label class="jce-q-field">
					<span>${__("Remarks")}</span>
					<input class="form-control" data-field="remarks" value="${esc(row.remarks || "")}" placeholder="${__("Remarks")}" ${submitted ? "disabled" : ""}>
				</label>
				${submitted ? `<span class="jce-q-muted jce-q-defect-name">${esc(row.defect_name || "")}</span>` : `<button class="jce-q-small-button icon danger" data-action="remove-defect" title="${__("Remove")}" aria-label="${__("Remove")}">${icon_html("trash-2")}</button>`}
			</div>
		`;
	}

	render_photos(doc, submitted) {
		const photos = [...(doc.defect_photos || [])]
			.map((row) => ({ ...(row || {}), image: clean_url(row?.image || row?.file_url) }))
			.filter((row) => row.image);
		const inspection_photo = clean_url(doc.inspection_photo);
		if (inspection_photo && !photos.some((row) => row.image === inspection_photo)) {
			photos.unshift({ image: inspection_photo, caption: __("Legacy Photo") });
		}
		if (!photos.length) {
			return `<div class="jce-q-empty compact">${__("No photos attached.")}</div>`;
		}
		return photos.map((row) => this.photo_row(row, submitted)).join("");
	}

	photo_row(row = {}, submitted = false) {
		const image = clean_url(row.image || row.file_url);
		if (!image) return "";
		return `
			<div class="jce-q-photo">
				<a href="${esc(image)}" target="_blank" rel="noreferrer"><img src="${esc(image)}" alt="${esc(row.caption || "")}"></a>
				<label class="jce-q-field">
					<span>${__("Caption")}</span>
					<input class="form-control" data-field="caption" value="${esc(row.caption || "")}" placeholder="${__("Caption")}" ${submitted ? "disabled" : ""}>
				</label>
				<input type="hidden" data-field="image" value="${esc(image)}">
				${submitted ? "" : `<button class="jce-q-small-button icon danger" data-action="remove-photo" title="${__("Remove")}" aria-label="${__("Remove")}">${icon_html("trash-2")}</button>`}
			</div>
		`;
	}

	render_readings_matrix(doc, submitted) {
		const rows = doc.readings || [];
		if (!rows.length) return "";
		const sample_count = this.get_sample_count(doc);
		const sample_map = this.get_sample_reading_map(doc);
		const columns = ["minmax(240px, 1.35fr)", ...Array.from({ length: sample_count }, () => "minmax(82px, 1fr)")].join(" ");
		const header = `
			<div class="jce-q-reading-matrix-row head" style="grid-template-columns:${columns}">
				<div>${__("Parameter")}</div>
				${Array.from({ length: sample_count }, (_, idx) => `<div>${__("Sample")} ${idx + 1}</div>`).join("")}
			</div>
		`;
		return `
			<div class="jce-q-reading-matrix" style="--sample-count:${sample_count}">
				${header}
				${rows.map((row) => this.render_reading_matrix_row(row, sample_count, sample_map, columns, submitted)).join("")}
			</div>
		`;
	}

	render_reading_matrix_row(row, sample_count, sample_map, columns, submitted) {
		const criteria = row.numeric
			? `${__("Min")}: ${esc(row.min_value ?? "")} · ${__("Max")}: ${esc(row.max_value ?? "")}`
			: `${__("Value")}: ${esc(row.value || "")}`;
		const metadata = this.render_reading_metadata(row, criteria);
		const inputs = Array.from({ length: sample_count }, (_, idx) => {
			const sample_no = idx + 1;
			const value = this.get_sample_cell_value(row, sample_no, sample_map);
			return `<input
				data-sample-reading="1"
				data-sample-no="${sample_no}"
				data-reading-idx="${esc(row.idx)}"
				data-specification="${esc(row.specification || "")}"
				value="${esc(value)}"
				${row.numeric ? 'inputmode="decimal"' : ""}
				${submitted ? "disabled" : ""}
			>`;
		}).join("");
		return `
			<div class="jce-q-reading-matrix-row" style="grid-template-columns:${columns}">
				<div class="jce-q-reading-spec">
					<b>${esc(row.specification)}</b>
					${metadata}
				</div>
				${inputs}
			</div>
		`;
	}

	render_reading_metadata(row, criteria) {
		const lines = [`<span>${criteria}</span>`];
		if (row.inspection_method) {
			lines.push(`<span>${__("Inspection Method")}: <a class="jce-q-reading-method" href="${esc(form_url("Quality Inspection Method", row.inspection_method))}" target="_blank" rel="noreferrer">${esc(row.inspection_method)}</a></span>`);
		}
		if (row.inspection_standard) {
			lines.push(`<span>${__("Inspection Standard")}: ${esc(row.inspection_standard)}</span>`);
		}
		return lines.join("");
	}

	get_sample_count(doc = this.current) {
		const explicit = cint(doc?.inspection_sample_qty);
		const max_existing = Math.max(0, ...(doc?.sample_readings || []).map((row) => cint(row.sample_no)));
		const planned = Math.max(0, ...(doc?.sample_plan || []).map((row) => cint(row.min_sample_qty)));
		return Math.max(explicit, max_existing, planned, 1);
	}

	get_sample_reading_map(doc = this.current) {
		const map = {};
		(doc?.sample_readings || []).forEach((row) => {
			const key = `${cint(row.source_reading_idx) || ""}::${row.specification || ""}::${cint(row.sample_no)}`;
			map[key] = row.reading_value || "";
		});
		return map;
	}

	get_sample_cell_value(row, sample_no, sample_map) {
		const key = `${cint(row.idx) || ""}::${row.specification || ""}::${sample_no}`;
		if (sample_map[key] !== undefined) return sample_map[key];
		return row[`reading_${sample_no}`] || "";
	}

	add_sample_column() {
		const payload = this.collect_payload();
		this.current.inspection_sample_qty = Math.max(cint(payload.inspection_sample_qty), this.get_sample_count(this.current)) + 1;
		this.current.inspection_stage = payload.inspection_stage || this.current.inspection_stage;
		this.current.sample_readings = payload.sample_readings;
		this.render_focus_shell();
	}

	collect_payload() {
		const root = this.body.find(".jce-q-focus-shell");
		const readings = [];
		const sample_readings = [];
		root.find("[data-sample-reading]").each((_, node) => {
			const input = $(node);
			sample_readings.push({
				sample_no: cint(input.data("sampleNo") || input.attr("data-sample-no")),
				source_reading_idx: cint(input.data("readingIdx") || input.attr("data-reading-idx")),
				specification: input.data("specification") || input.attr("data-specification"),
				reading_value: input.val(),
			});
		});
		const defects = [];
		root.find(".jce-q-defect-row").each((_, node) => {
			const row = $(node);
			const defect_code = row.find('[data-field="defect_code"]').val();
			if (!defect_code) return;
			defects.push({
				defect_code,
				quantity: row.find('[data-field="quantity"]').val() || 1,
				remarks: row.find('[data-field="remarks"]').val(),
			});
		});
		const defect_photos = [];
		root.find(".jce-q-photo").each((_, node) => {
			const row = $(node);
			const image = clean_url(row.find('[data-field="image"]').val());
			if (!image) return;
			defect_photos.push({
				image,
				caption: row.find('[data-field="caption"]').val(),
			});
		});
		return {
			check_name: this.current.name,
			sample_manager: this.sampleControl ? this.sampleControl.get_value() : root.find('[data-field="sample_manager"]').val(),
			manual_inspection: root.find('[data-field="manual_inspection"]').is(":checked") ? 1 : 0,
			overall_status: root.find('[data-field="overall_status"]').val(),
			inspection_stage: root.find('[data-field="inspection_stage"]').val(),
			inspection_sample_qty: root.find('[data-field="inspection_sample_qty"]').val() || this.get_sample_count(),
			remarks: root.find('[data-field="remarks"]').val(),
			readings,
			sample_readings,
			defects,
			defect_photos,
		};
	}

	save_check(submit) {
		const payload = this.collect_payload();
		frappe.call({
			method: submit ? "jce_quality.api.quality.submit_check" : "jce_quality.api.quality.save_check",
			args: payload,
			freeze: true,
			freeze_message: submit ? __("Submitting inspection...") : __("Saving draft..."),
		}).then((r) => {
			this.current = r.message;
			this.render_focus_shell();
			this.refresh();
		});
	}

	start_check() {
		frappe.call({
			method: "jce_quality.api.quality.start_check",
			args: { check_name: this.current.name },
		}).then((r) => {
			this.current = r.message;
			this.render_focus_shell();
		});
	}

	mark_ng() {
		const root = this.body.find(".jce-q-focus-shell");
		root.find('[data-field="manual_inspection"]').prop("checked", true);
		root.find('[data-field="overall_status"]').val("Rejected");
		this.save_check(false);
	}

	add_defect_row() {
		const container = this.body.find(".jce-q-defects");
		container.find(".jce-q-empty").remove();
		const row = $(this.defect_row({}, false)).appendTo(container);
		this.setup_defect_controls(false, row);
		row.find('[data-action="remove-defect"]').on("click", () => row.remove());
	}

	apply_concession() {
		this.open_disposition_sheet("Concession Release");
	}

	open_disposition_sheet(disposition) {
		if (!this.current || !disposition) return;
		const action_note = this.build_action_note(this.current);
		this.open_terminal_sheet({
			title: __(disposition),
			body: `
				<div class="jce-q-dialog-summary">${esc(action_note)}</div>
				<label class="jce-q-sheet-field">
					<span>${__("Disposition Remarks")}</span>
					<textarea data-sheet-field="remarks">${esc(this.current.disposition_remarks || action_note || "")}</textarea>
				</label>
			`,
			primary_label: __("Save"),
			on_primary: async (sheet) => {
				const remarks = sheet.find('[data-sheet-field="remarks"]').val();
				const r = await frappe.call({
					method: "jce_quality.api.quality.set_disposition",
					args: {
						check_name: this.current.name,
						disposition,
						remarks,
					},
					freeze: true,
					freeze_message: __("Saving disposition..."),
				});
				this.current = r.message;
				this.close_terminal_sheet();
				this.render_focus_shell();
				this.refresh();
			},
		});
	}

	approve_concession_release() {
		if (!this.current) return;
		this.open_terminal_sheet({
			title: __("Approve Concession"),
			body: `<div class="jce-q-dialog-summary">${esc(this.build_action_note(this.current) || __("Approve concession release for this NG inspection."))}</div>`,
			primary_label: __("Approve"),
			on_primary: async () => {
				const r = await frappe.call({
					method: "jce_quality.api.quality.approve_concession_release",
					args: { check_name: this.current.name },
					freeze: true,
					freeze_message: __("Approving concession..."),
				});
				this.current = r.message;
				this.close_terminal_sheet();
				this.render_focus_shell();
				this.refresh();
			},
		});
	}

	open_note_sheet() {
		if (!this.current) return;
		this.open_terminal_sheet({
			title: __("Add Note"),
			body: `
				<label class="jce-q-sheet-field">
					<span>${__("Operator Note")}</span>
					<textarea data-sheet-field="remarks">${esc(this.current.remarks || "")}</textarea>
				</label>
			`,
			primary_label: __("Save"),
			on_primary: async (sheet) => {
				const remarks = sheet.find('[data-sheet-field="remarks"]').val();
				const r = await frappe.call({
					method: "jce_quality.api.quality.save_check",
					args: {
						check_name: this.current.name,
						remarks,
					},
					freeze: true,
					freeze_message: __("Saving note..."),
				});
				this.current = r.message;
				this.close_terminal_sheet();
				this.render_focus_shell();
				this.refresh();
			},
		});
	}

	attach_photo() {
		if (!window.isSecureContext) {
			frappe.msgprint({
				title: __("Camera is not available"),
				message: __("Camera access requires HTTPS or a secure local context on Apple devices."),
				indicator: "orange",
			});
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia) {
			this.open_camera_file_fallback();
			return;
		}
		this.open_camera_capture_dialog();
	}

	open_camera_file_fallback() {
		const input = $('<input type="file" accept="image/*" capture="environment" style="display:none">').appendTo(document.body);
		input.on("change", async () => {
			const file = input.get(0)?.files?.[0];
			input.remove();
			if (!file) {
				return;
			}
			try {
				const caption = "";
				const filename = file.name || `${this.current.name}_${format_filename_datetime(new Date())}.jpg`;
				const file_url = await this.upload_photo_file(file, filename);
				const payload = this.collect_payload();
				payload.defect_photos.push({ image: file_url, caption });
				const args = this.current.docstatus
					? { check_name: this.current.name, defect_photos: [{ image: file_url, caption }] }
					: payload;
				const r = await frappe.call({
					method: "jce_quality.api.quality.save_check",
					args,
					freeze: true,
					freeze_message: __("Saving photo..."),
				});
				this.current = r.message;
				frappe.show_alert({ message: __("Photo saved."), indicator: "green" });
				this.render_focus_shell();
			} catch (error) {
				console.error(error);
				frappe.msgprint({
					title: __("Unable to save photo"),
					message: error.message || String(error),
					indicator: "red",
				});
			}
		});
		input.trigger("click");
	}

	open_camera_capture_dialog() {
		const doc = this.current;
		let stream = null;
		let captured = false;
		let current_device_id = "";
		let device_list = [];
		let base_image_data = null;
		let annotation_tool = "rect";
		let annotation_shapes = [];
		let active_shape = null;
		const d = new frappe.ui.Dialog({
			title: __("Capture Photo"),
			size: "large",
			fields: [
				{ fieldtype: "HTML", fieldname: "camera_area" },
				{ fieldtype: "Select", fieldname: "camera_device", label: __("Camera Device"), options: [] },
				{ fieldtype: "Check", fieldname: "mirror", label: __("Mirror Preview"), default: 0 },
			],
			primary_action_label: __("Save Photo"),
			primary_action: async () => {
				if (!captured) {
					frappe.msgprint(__("Please take a photo before saving."));
					return;
				}
				try {
					d.get_primary_btn().prop("disabled", true);
					const canvas = d.$wrapper.find(".jce-q-camera-canvas").get(0);
					const caption = "";
					const file_url = await this.upload_captured_canvas(canvas);
					const payload = this.collect_payload();
					payload.defect_photos.push({ image: file_url, caption });
					const args = this.current.docstatus
						? { check_name: this.current.name, defect_photos: [{ image: file_url, caption }] }
						: payload;
					const r = await frappe.call({
						method: "jce_quality.api.quality.save_check",
						args,
						freeze: true,
						freeze_message: __("Saving photo..."),
					});
					this.current = r.message;
					frappe.show_alert({ message: __("Photo saved."), indicator: "green" });
					stop_stream();
					d.hide();
					this.render_focus_shell();
				} catch (error) {
					console.error(error);
					d.get_primary_btn().prop("disabled", false);
					frappe.msgprint({
						title: __("Unable to save photo"),
						message: error.message || String(error),
						indicator: "red",
					});
				}
			},
		});

		d.show();
		d.get_primary_btn().prop("disabled", true);
		const $camera = d.get_field("camera_area").$wrapper;
		$camera.html(`
				<div class="jce-q-camera-wrap">
					<div class="jce-q-camera-stage">
						<video class="jce-q-camera-video" autoplay playsinline muted></video>
						<canvas class="jce-q-camera-canvas" hidden></canvas>
						<canvas class="jce-q-annotation-canvas" hidden></canvas>
						<div class="jce-q-camera-badge">${esc(this.get_photo_watermark_lines(doc).join(" · "))}</div>
						<button type="button" class="jce-q-camera-shot" data-camera-action="capture" title="${__("Capture Photo")}" aria-label="${__("Capture Photo")}">${icon_html("camera")}</button>
						<button type="button" class="jce-q-camera-retake" data-camera-action="retake" title="${__("Retake")}" aria-label="${__("Retake")}" hidden>${icon_html("rotate-ccw")}</button>
					</div>
					<div class="jce-q-camera-tools" hidden>
						<button type="button" class="jce-q-small-button active" data-annotation-tool="rect">${icon_html("square")}</button>
						<button type="button" class="jce-q-small-button" data-annotation-tool="circle">${icon_html("circle")}</button>
						<button type="button" class="jce-q-small-button" data-camera-action="undo">${icon_html("undo-2")}</button>
						<button type="button" class="jce-q-small-button" data-camera-action="clear">${icon_html("trash-2")}</button>
					</div>
				<div class="jce-q-camera-hint">${__("The photo will be saved with an inspection watermark in the lower right corner.")}</div>
			</div>
		`);

		const video = $camera.find(".jce-q-camera-video").get(0);
		const canvas = $camera.find(".jce-q-camera-canvas").get(0);
		const annotation_canvas = $camera.find(".jce-q-annotation-canvas").get(0);
		const $shot = $camera.find('[data-camera-action="capture"]');
		const $retake = $camera.find('[data-camera-action="retake"]');
		const $tools = $camera.find(".jce-q-camera-tools");
		const device_field = d.get_field("camera_device");
		device_field.$wrapper.hide();

		const stop_stream = () => {
			if (stream) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
			}
		};
		const start_stream = async (video_constraint) => {
			stop_stream();
			stream = await navigator.mediaDevices.getUserMedia({
				video: video_constraint || { facingMode: { ideal: "environment" } },
				audio: false,
			});
			video.srcObject = stream;
			const track = stream.getVideoTracks?.()[0];
			const settings = track?.getSettings?.() || {};
			current_device_id = settings.deviceId || current_device_id;
			this.apply_camera_mirror(video, !!d.get_value("mirror"));
		};
		const refresh_devices = async () => {
			if (!navigator.mediaDevices?.enumerateDevices) return;
			device_list = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
			if (device_list.length <= 1) {
				device_field.$wrapper.hide();
				return;
			}
			const options = device_list.map((device, index) => `${index + 1}: ${device.label || __("Camera") + " " + (index + 1)}`);
			device_field.df.options = options.join("\n");
			device_field.refresh();
			const idx = Math.max(0, device_list.findIndex((device) => device.deviceId === current_device_id));
			d.set_value("camera_device", options[idx]);
			device_field.$wrapper.show();
		};
		const set_captured = (enabled) => {
			captured = enabled;
			if (!enabled) {
				base_image_data = null;
				annotation_shapes = [];
				active_shape = null;
				clear_annotation_overlay(annotation_canvas);
			}
			d.get_primary_btn().prop("disabled", !enabled);
			$(video).prop("hidden", enabled);
			$(canvas).prop("hidden", !enabled);
			$(annotation_canvas).prop("hidden", !enabled);
			$shot.prop("hidden", enabled);
			$retake.prop("hidden", !enabled);
			$tools.prop("hidden", !enabled);
		};
		const redraw_final = () => {
			if (!base_image_data) return;
			const ctx = canvas.getContext("2d");
			ctx.putImageData(base_image_data, 0, 0);
			annotation_shapes.forEach((shape) => draw_photo_annotation(ctx, shape, canvas.width, canvas.height));
		};
		const get_canvas_point = (event) => {
			const rect = canvas.getBoundingClientRect();
			return {
				x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
				y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
			};
		};

		$shot.on("click", () => {
			if (!video.videoWidth || !video.videoHeight) {
				frappe.msgprint(__("Camera is not ready yet."));
				return;
			}
			const watermark = this.get_photo_watermark_lines(doc);
			render_inspection_photo(video, canvas, {
				mirror: !!d.get_value("mirror"),
				watermark,
			});
			base_image_data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
			set_captured(true);
		});
		$retake.on("click", () => set_captured(false));
		$tools.find("[data-annotation-tool]").on("click", (event) => {
			annotation_tool = event.currentTarget.dataset.annotationTool;
			$tools.find("[data-annotation-tool]").removeClass("active");
			$(event.currentTarget).addClass("active");
		});
		$camera.find('[data-camera-action="undo"]').on("click", () => {
			annotation_shapes.pop();
			redraw_final();
		});
		$camera.find('[data-camera-action="clear"]').on("click", () => {
			annotation_shapes = [];
			redraw_final();
			clear_annotation_overlay(annotation_canvas);
		});
		$(annotation_canvas).on("pointerdown", (event) => {
			if (!captured) return;
			annotation_canvas.setPointerCapture?.(event.originalEvent.pointerId);
			const start = get_canvas_point(event.originalEvent);
			active_shape = { tool: annotation_tool, start, end: start };
		});
		$(annotation_canvas).on("pointermove", (event) => {
			if (!active_shape) return;
			active_shape.end = get_canvas_point(event.originalEvent);
			draw_annotation_overlay(annotation_canvas, active_shape);
		});
		$(annotation_canvas).on("pointerup pointercancel", (event) => {
			if (!active_shape) return;
			active_shape.end = get_canvas_point(event.originalEvent);
			annotation_shapes.push(active_shape);
			active_shape = null;
			clear_annotation_overlay(annotation_canvas);
			redraw_final();
		});
		d.get_field("mirror").$input.on("change", () => this.apply_camera_mirror(video, !!d.get_value("mirror")));
		device_field.$wrapper.on("change", "select,input", async () => {
			const selected = d.get_value("camera_device") || "";
			const index = cint(String(selected).split(":")[0]) - 1;
			const device = device_list[index];
			if (!device?.deviceId || device.deviceId === current_device_id) return;
			await start_stream({ deviceId: { exact: device.deviceId } });
			set_captured(false);
		});
		d.$wrapper.on("hide.bs.modal", () => stop_stream());

		start_stream()
			.then(refresh_devices)
			.catch((error) => {
				console.error(error);
				frappe.msgprint({
					title: __("Camera is not available on this device or browser."),
					message: error.message || String(error),
					indicator: "red",
				});
			});
	}

	apply_camera_mirror(video, mirror) {
		if (video) {
			video.style.transform = mirror ? "scaleX(-1)" : "none";
		}
	}

	get_photo_watermark_lines(doc = this.current) {
		return [
			`${__("Inspection Process")}: ${quality_process_label(doc?.quality_node)}`,
			`${__("Item Code")}: ${doc?.item_code || "-"}`,
			`${__("Time")}: ${format_local_datetime(new Date())}`,
			`${__("Inspector")}: ${current_user_label()}`,
		];
	}

	async upload_captured_canvas(canvas) {
		const blob = await canvas_to_blob(canvas, "image/jpeg", 0.9);
		const filename = `${this.current.name}_${format_filename_datetime(new Date())}.jpg`;
		return this.upload_photo_file(blob, filename);
	}

	async upload_photo_file(file, filename) {
		const form = new FormData();
		form.append("file", file, filename);
		form.append("doctype", "Production Quality Check");
		form.append("docname", this.current.name);
		form.append("folder", "Home/Attachments");
		form.append("is_private", "1");
		if (frappe.csrf_token) {
			form.append("csrf_token", frappe.csrf_token);
		}
		const url = frappe.urllib?.get_full_url
			? frappe.urllib.get_full_url("/api/method/upload_file")
			: "/api/method/upload_file";
		const response = await fetch(url, {
			method: "POST",
			body: form,
			headers: frappe.csrf_token ? { "X-Frappe-CSRF-Token": frappe.csrf_token } : {},
		});
		let data = null;
		try {
			data = await response.json();
		} catch (error) {
			// keep response status as the source of truth
		}
		if (!response.ok || data?.exc) {
			throw new Error(data?.exception || data?.exc_type || response.statusText || "Upload failed");
		}
		const file_url = clean_url(data?.message?.file_url);
		if (!file_url) {
			throw new Error(__("Upload completed but no file URL was returned."));
		}
		return file_url;
	}

	create_dmr_from_current() {
		const doc = this.current;
		frappe.call({
			method: "jce_quality.api.dmr.create_dmr_from_source",
			args: {
				source_doctype: "Production Quality Check",
				source_name: doc.name,
				item_code: doc.item_code,
				dmr_type: "IPQC",
			},
			freeze: true,
			freeze_message: __("Creating DMR..."),
		}).then((r) => {
			if (r.message) frappe.set_route("Form", "DMR", r.message);
		});
	}

	trigger_defect_alert(alert_note = null) {
		const note = alert_note || this.build_action_note(this.current) || this.current.remarks || __("Patrol NG found on {0}.", [this.current.name]);
		return frappe.call({
			method: "jce_quality.api.quality.trigger_defect_alert",
			args: { check_name: this.current.name, alert_note: note },
			freeze: true,
			freeze_message: __("Recording defect alert..."),
		}).then((r) => {
			frappe.show_alert({ message: __("Schedule warning recorded."), indicator: "orange" });
			this.current.scheduling_alert_note = r.message?.alert_note || this.current.scheduling_alert_note;
			this.render_focus_shell();
			this.refresh();
		});
	}

	increase_patrol_count(increment = null, remarks = null) {
		if (increment === null) {
			frappe.prompt(
				[
					{ fieldname: "increment", fieldtype: "Int", label: __("Additional Patrol Count"), default: 1, reqd: 1 },
					{ fieldname: "remarks", fieldtype: "Small Text", label: __("Alert Note"), default: this.build_action_note(this.current) },
				],
				(values) => this.increase_patrol_count(Math.max(1, cint(values.increment || 1)), values.remarks),
				__("Increase Patrol")
			);
			return Promise.resolve();
		}
		return frappe.call({
			method: "jce_quality.api.quality.increase_patrol_count",
			args: {
				check_name: this.current.name,
				increment,
				remarks: remarks || this.build_action_note(this.current) || this.current.remarks || __("Patrol NG found on {0}.", [this.current.name]),
			},
			freeze: true,
			freeze_message: __("Increasing patrol frequency..."),
		}).then((r) => {
			this.current = r.message;
			frappe.show_alert({ message: __("Patrol frequency increased for this scheduling item."), indicator: "orange" });
			this.render_focus_shell();
			this.refresh();
		});
	}

	write_warning_note() {
		frappe.prompt(
			[
				{
					fieldname: "alert_note",
					fieldtype: "Small Text",
					label: __("Warning Note"),
					reqd: 1,
					default: this.build_action_note(this.current) || this.current.remarks || __("Patrol NG found on {0}.", [this.current.name]),
				},
			],
			(values) => {
				frappe.call({
					method: "jce_quality.api.quality.trigger_defect_alert",
					args: {
						check_name: this.current.name,
						alert_note: values.alert_note,
					},
					freeze: true,
					freeze_message: __("Saving warning note..."),
				}).then(() => {
					this.current.scheduling_alert_note = values.alert_note;
					this.render_focus_shell();
					this.refresh();
				});
			},
			__("Schedule Warning")
		);
	}

	load_defect_options() {
		frappe.call({ method: "jce_quality.api.quality.get_defect_code_options" }).then((r) => {
			this.defect_options = r.message || [];
			let datalist = document.getElementById("jce-q-defect-options");
			if (!datalist) {
				datalist = document.createElement("datalist");
				datalist.id = "jce-q-defect-options";
				document.body.appendChild(datalist);
			}
			datalist.innerHTML = this.defect_options
				.map((row) => `<option value="${esc(row.defect_code)}">${esc(row.defect_name || row.defect_code)}</option>`)
				.join("");
		});
	}

	install_pwa_head() {
		if (!document.querySelector('link[rel="manifest"][href="/assets/jce_quality/manifest.webmanifest"]')) {
			const link = document.createElement("link");
			link.rel = "manifest";
			link.href = "/assets/jce_quality/manifest.webmanifest";
			document.head.appendChild(link);
		}
		const meta_values = {
			"apple-mobile-web-app-capable": "yes",
			"mobile-web-app-capable": "yes",
			"apple-mobile-web-app-title": "JCE Quality",
			"apple-mobile-web-app-status-bar-style": "black-translucent",
			"theme-color": "#f5f5f7",
		};
		Object.keys(meta_values).forEach((name) => {
			let meta = document.querySelector(`meta[name="${name}"]`);
			if (!meta) {
				meta = document.createElement("meta");
				meta.name = name;
				document.head.appendChild(meta);
			}
			meta.content = meta_values[name];
		});
	}

	inject_style() {
		if (document.getElementById("jce-quality-terminal-style")) return;
		$(`<style id="jce-quality-terminal-style">
				body.jce-quality-terminal-focus-active .page-head,
				body.jce-quality-terminal-focus-active .page-title,
				body.jce-quality-terminal-focus-active .standard-sidebar-section { display: none !important; }
				body.jce-quality-terminal-focus-active {
					overflow: hidden !important;
					touch-action: pan-x pan-y;
					overscroll-behavior: none;
				}
				body.jce-quality-terminal-focus-active .page-container,
				body.jce-quality-terminal-focus-active .page-content,
				body.jce-quality-terminal-focus-active .layout-main-section-wrapper,
				body.jce-quality-terminal-focus-active .layout-main-section {
					padding: 0 !important;
					margin: 0 !important;
					max-width: none !important;
				}
				.jce-q-terminal {
					--jce-bg: #f5f5f7;
					--jce-surface: #ffffff;
					--jce-surface-soft: #ffffff;
					--jce-line: rgba(0, 0, 0, 0.10);
					--jce-line-soft: rgba(0, 0, 0, 0.06);
					--jce-text: #1d1d1f;
					--jce-muted: #6e6e73;
						--jce-blue: #0071e3;
						--jce-green: #248a3d;
						--jce-teal: #0a7c70;
						--jce-orange: #b65a00;
						--jce-red: #c01f2f;
					min-height: calc(100vh - 86px);
					background: var(--jce-bg);
					color: var(--jce-text);
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				}
				.jce-q-terminal.jce-terminal-focus {
					width: 100%;
					min-height: 100dvh;
					overflow: hidden;
				}
				.jce-q-terminal.jce-terminal-fullscreen {
					position: fixed;
					inset: 0;
					z-index: 1040;
					width: 100vw;
					height: 100dvh;
					min-height: 100dvh;
					overflow: hidden;
				}
				body.jce-quality-terminal-fullscreen-active .jce-q-terminal.jce-terminal-fullscreen {
					z-index: 2147483000;
				}
				body.jce-quality-terminal-fullscreen-active .modal-backdrop,
				body.jce-quality-terminal-fullscreen-active #freeze {
					z-index: 2147483200 !important;
				}
				body.jce-quality-terminal-fullscreen-active .modal {
					z-index: 2147483300 !important;
				}
				body.jce-quality-terminal-fullscreen-active .datepicker,
				body.jce-quality-terminal-fullscreen-active .ui-datepicker,
				body.jce-quality-terminal-fullscreen-active .dropdown-menu,
				body.jce-quality-terminal-fullscreen-active .awesomplete ul,
				body.jce-quality-terminal-fullscreen-active .awesomplete [role="listbox"] {
					z-index: 2147483400 !important;
				}
				body.jce-quality-terminal-fullscreen-active .modal.show {
					display: block !important;
					overflow: hidden !important;
				}
				body.jce-quality-terminal-fullscreen-active .modal-dialog {
					margin: max(8px, env(safe-area-inset-top)) auto max(8px, env(safe-area-inset-bottom));
					max-height: calc(100dvh - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)));
				}
				body.jce-quality-terminal-focus-active .modal-content {
					max-height: inherit;
					display: flex;
					flex-direction: column;
					overflow: hidden;
				}
				body.jce-quality-terminal-focus-active .modal-body {
					flex: 1 1 auto;
					min-height: 0;
					overflow: hidden;
				}
				.modal.jce-q-manual-check-modal .modal-dialog,
				body.jce-quality-terminal-focus-active .modal.jce-q-manual-check-modal .modal-dialog {
					max-width: min(920px, calc(100vw - 24px));
					max-height: calc(100dvh - 24px);
				}
				.modal.jce-q-manual-check-modal .modal-content,
				body.jce-quality-terminal-focus-active .modal.jce-q-manual-check-modal .modal-content {
					max-height: calc(100dvh - 24px);
					overflow: hidden;
				}
				.modal.jce-q-manual-check-modal .modal-body,
				body.jce-quality-terminal-focus-active .modal.jce-q-manual-check-modal .modal-body {
					overflow-y: auto !important;
					overflow-x: hidden !important;
					max-height: calc(100dvh - 148px);
					padding-bottom: 10px;
					-webkit-overflow-scrolling: touch;
				}
				.modal.jce-q-manual-check-modal .modal-footer,
				body.jce-quality-terminal-focus-active .modal.jce-q-manual-check-modal .modal-footer {
					position: sticky;
					bottom: 0;
					z-index: 1;
					background: #fff;
				}
				.modal.jce-q-manual-check-modal .form-section {
					margin-bottom: 4px;
				}
				.modal.jce-q-manual-check-modal .form-group {
					margin-bottom: 9px;
				}
				body.jce-quality-terminal-focus-active .modal-footer {
					flex: 0 0 auto;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header {
					position: sticky;
					top: 0;
					display: flex !important;
					align-items: center !important;
					min-height: 58px;
					padding-right: 96px !important;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header .title-section {
					min-width: 0;
					flex: 1 1 auto;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header .modal-title {
					max-width: 100% !important;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header .modal-actions {
					position: absolute;
					top: 50%;
					right: 12px;
					display: inline-flex !important;
					align-items: center;
					justify-content: flex-end;
					gap: 4px;
					margin: 0 !important;
					transform: translateY(-50%);
				}
				body.jce-quality-terminal-focus-active .modal .modal-header .btn-modal-close,
				body.jce-quality-terminal-focus-active .modal .modal-header .btn-modal-minimize,
				body.jce-quality-terminal-focus-active .modal .modal-header .btn-close,
				body.jce-quality-terminal-focus-active .modal .modal-header .close {
					width: 36px;
					min-width: 36px;
					height: 36px;
					min-height: 36px;
					display: inline-flex;
					align-items: center;
					justify-content: center;
					padding: 0 !important;
					border-radius: 8px;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header > .btn-modal-close,
				body.jce-quality-terminal-focus-active .modal .modal-header > .btn-close,
				body.jce-quality-terminal-focus-active .modal .modal-header > .close {
					position: absolute !important;
					top: 50% !important;
					right: 12px !important;
					margin: 0 !important;
					transform: translateY(-50%) !important;
				}
				body.jce-quality-terminal-focus-active .modal .modal-header svg {
					display: block;
					margin: 0;
				}
				.jce-q-terminal:fullscreen {
					width: 100vw;
					height: 100dvh;
					min-height: 100dvh;
					overflow: hidden;
				}
				.jce-q-terminal * {
					box-sizing: border-box;
					letter-spacing: 0;
				}
				.jce-q-task-shell {
					max-width: 1480px;
					margin: 0 auto;
					padding: 10px clamp(10px, 1.8vw, 18px) 20px;
				}
				.jce-terminal-fullscreen .jce-q-task-shell {
					height: 100dvh;
					max-height: 100dvh;
					overflow: auto;
					-webkit-overflow-scrolling: touch;
					overscroll-behavior: contain;
				}
				.jce-q-list-header {
					display: flex;
					align-items: flex-end;
					justify-content: space-between;
					gap: 12px;
					margin-bottom: 8px;
				}
				.jce-q-eyebrow,
				.jce-q-filter-title,
				.jce-q-section-head > div > span,
				.jce-q-field > span,
				.jce-q-info-item span,
				.jce-q-drawing-title span {
					display: block;
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 700;
					line-height: 1.25;
					text-transform: uppercase;
				}
				.jce-q-list-header h2 {
					margin: 1px 0 0;
					font-size: clamp(20px, 2.2vw, 28px);
					font-weight: 760;
					line-height: 1.08;
				}
				.jce-q-list-metrics {
					display: flex;
					align-items: center;
					justify-content: flex-end;
					gap: 6px;
					flex-wrap: wrap;
				}
				.jce-q-list-actions {
					display: flex;
					align-items: center;
					justify-content: flex-end;
					gap: 8px;
					min-width: 0;
				}
				.jce-q-list-metrics > div {
					min-height: 34px;
					min-width: 58px;
					padding: 5px 8px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 999px;
					background: var(--jce-surface-soft);
					box-shadow: none;
				}
				.jce-q-list-metrics span {
					display: inline;
					color: var(--jce-muted);
					font-size: 10px;
					font-weight: 700;
				}
					.jce-q-list-metrics b {
						display: inline;
						margin-left: 5px;
						font-size: 14px;
						line-height: 1;
					}
					.jce-q-entry-panel {
						display: flex;
						align-items: center;
						flex-wrap: wrap;
						gap: 8px;
						margin-bottom: 10px;
					}
					.jce-q-entry-action {
						min-width: 0;
						min-height: 44px;
						display: inline-flex;
						align-items: center;
						gap: 8px;
						padding: 7px 11px 7px 8px;
						border: 1px solid var(--jce-line-soft);
						border-radius: 8px;
						background: rgba(255, 255, 255, 0.82);
						color: var(--jce-text);
						text-align: left;
						box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
						backdrop-filter: saturate(1.5) blur(14px);
						-webkit-backdrop-filter: saturate(1.5) blur(14px);
						transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, background .16s ease;
					}
					.jce-q-entry-action:hover {
						transform: translateY(-1px);
						border-color: rgba(0, 113, 227, 0.22);
						background: #fff;
						box-shadow: 0 6px 16px rgba(0, 0, 0, 0.07);
					}
					.jce-q-entry-action.ipqc {
						color: #07549f;
					}
					.jce-q-entry-action.oqc {
						color: #075f58;
					}
					.jce-q-entry-icon {
						width: 30px;
						min-width: 30px;
						height: 30px;
						display: inline-flex;
						align-items: center;
						justify-content: center;
						border-radius: 8px;
						background: #f5f5f7;
					}
					.jce-q-entry-action.ipqc .jce-q-entry-icon {
						color: var(--jce-blue);
					}
					.jce-q-entry-action.oqc .jce-q-entry-icon {
						color: var(--jce-teal);
					}
					.jce-q-entry-copy {
						min-width: 0;
					}
					.jce-q-entry-copy b,
					.jce-q-entry-copy em {
						display: block;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
					.jce-q-entry-copy b {
						font-size: 13px;
						font-weight: 800;
						line-height: 1;
					}
					.jce-q-entry-copy em {
						margin-top: 2px;
						color: var(--jce-muted);
						font-size: 11px;
						font-style: normal;
						font-weight: 650;
					}
					.jce-q-filter-panel {
						margin-bottom: 12px;
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: rgba(255, 255, 255, 0.68);
				}
				.jce-q-filter-head {
					display: block;
				}
				.jce-q-mobile-filter-refresh {
					display: none !important;
				}
				.jce-q-toolbar {
					display: grid;
					grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr) auto;
					align-items: flex-end;
					gap: 10px;
					margin-top: 6px;
				}
				.jce-q-filter {
					min-width: 0;
				}
				.jce-q-filter .frappe-control,
				.jce-q-filter .input-max-width {
					max-width: none;
				}
				.jce-q-filter .form-group,
				.jce-q-filter .frappe-control {
					margin-bottom: 0;
				}
				.jce-q-filter .control-label {
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 700;
				}
				.jce-q-filter-action {
					display: flex;
					align-items: flex-end;
					justify-content: flex-end;
					height: 100%;
				}
				.jce-q-filter-refresh {
					width: 36px !important;
					min-width: 36px !important;
					height: 36px;
					min-height: 36px;
				}
				.jce-q-filter .form-control,
				.jce-q-field .form-control,
				.jce-q-remarks,
				.jce-q-reading-inputs input,
				.jce-q-reading-matrix-row input,
				.jce-q-readonly-link {
					width: 100%;
					min-height: 36px;
					border: 1px solid #d2d2d7;
					border-radius: 8px;
					background: #fff;
					color: var(--jce-text);
					box-shadow: none;
				}
				.jce-q-filter .form-control,
				.jce-q-field .form-control,
				.jce-q-reading-inputs input,
				.jce-q-reading-matrix-row input,
				.jce-q-readonly-link {
					height: 36px;
				}
				.jce-q-filter .form-control:focus,
				.jce-q-field .form-control:focus,
				.jce-q-remarks:focus,
				.jce-q-reading-inputs input:focus,
				.jce-q-reading-matrix-row input:focus {
					border-color: var(--jce-blue);
					box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
					outline: none;
				}
				.jce-q-touch {
					min-height: 36px;
					min-width: 56px;
				}
				.jce-q-task-list {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
					gap: 12px;
				}
					.jce-q-task {
						background: var(--jce-surface);
						border: 1px solid var(--jce-line-soft);
						border-radius: 8px;
						padding: 10px;
						box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05);
					}
					.jce-q-task.has-fai {
						border-color: rgba(0, 113, 227, 0.28);
						box-shadow: inset 3px 0 0 var(--jce-blue), 0 10px 30px rgba(0, 0, 0, 0.05);
					}
				.jce-q-task-card-head,
				.jce-q-task-title,
				.jce-q-section-head,
				.jce-q-drawing-toolbar {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
				}
				.jce-q-station {
					display: inline-flex;
					align-items: center;
					min-height: 24px;
					max-width: 58%;
					padding: 0 8px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 999px;
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-task-badges {
					display: flex;
					justify-content: flex-end;
					gap: 4px;
					flex-wrap: wrap;
				}
				.jce-q-task-title {
					align-items: flex-start;
					margin-top: 6px;
				}
				.jce-q-task-title b {
					display: block;
					font-size: 16px;
					line-height: 1.18;
					overflow-wrap: anywhere;
				}
				.jce-q-task-title em {
					display: block;
					margin-top: 2px;
					color: #2f6fbb;
					font-size: 12px;
					font-style: normal;
					font-weight: 700;
					line-height: 1.25;
					overflow-wrap: anywhere;
				}
				.jce-q-task-title span {
					display: block;
					margin-top: 2px;
					color: var(--jce-muted);
					font-size: 12px;
					line-height: 1.25;
				}
				.jce-q-task-alert {
					margin-top: 7px;
					padding: 7px 9px;
					border: 1px solid rgba(192, 31, 47, 0.20);
					border-radius: 8px;
					background: #fff1f2;
					color: var(--jce-red);
					font-weight: 700;
					display: -webkit-box;
					-webkit-line-clamp: 2;
					-webkit-box-orient: vertical;
					overflow: hidden;
				}
				.jce-q-task-ng-list {
					display: grid;
					gap: 6px;
					margin-top: 7px;
					padding: 8px;
					border: 1px solid rgba(192, 31, 47, 0.14);
					border-radius: 8px;
					background: #fff7f8;
				}
				.jce-q-task-ng-title,
				.jce-q-task-ng-row {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
				}
				.jce-q-task-ng-title span,
				.jce-q-task-ng-row span {
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 800;
				}
				.jce-q-task-ng-title b,
				.jce-q-task-ng-row b {
					font-size: 12px;
					font-weight: 850;
				}
				.jce-q-task-ng-row {
					width: 100%;
					min-height: 34px;
					padding: 0 9px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
					text-align: left;
				}
				.jce-q-task-ng-row.danger b { color: var(--jce-red); }
				.jce-q-task-ng-row.warn b { color: var(--jce-orange); }
				.jce-q-task-meta-grid {
					display: grid;
					grid-template-columns: repeat(4, minmax(0, 1fr));
					gap: 1px;
					margin-top: 8px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					overflow: hidden;
					background: var(--jce-line-soft);
				}
				.jce-q-task-meta-grid > div {
					min-width: 0;
					padding: 7px 9px;
					background: #fbfbfd;
				}
				.jce-q-task-meta-grid span {
					display: block;
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 700;
				}
				.jce-q-task-meta-grid b {
					display: block;
					margin-top: 2px;
					font-size: 13px;
					line-height: 1.25;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-node-row {
					display: grid;
					grid-template-columns: repeat(4, minmax(0, 1fr));
					gap: 6px;
					margin-top: 8px;
				}
				.jce-q-node {
					min-height: 50px;
					border: 1px solid transparent;
					border-radius: 8px;
					background: #f2f2f7;
					color: var(--jce-text);
					font-weight: 700;
					padding: 7px 8px;
					text-align: left;
					transition: background .16s ease, border-color .16s ease, transform .16s ease;
				}
				.jce-q-node:hover:not(:disabled) {
					border-color: rgba(0, 113, 227, 0.24);
					transform: translateY(-1px);
				}
				.jce-q-node:disabled {
					cursor: not-allowed;
					opacity: .56;
				}
				.jce-q-node span,
				.jce-q-node b,
				.jce-q-node em {
					display: block;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-node b {
					margin-top: 3px;
					color: var(--jce-muted);
					font-size: 11px;
				}
				.jce-q-node em {
					margin-top: 2px;
					color: var(--jce-orange);
					font-size: 10px;
					font-style: normal;
					font-weight: 800;
				}
				.jce-q-node.sequence-warn {
					border-color: rgba(182, 90, 0, 0.24);
				}
					.jce-q-node.ok { background: #ecf9f0; color: var(--jce-green); }
					.jce-q-node.warn { background: #fff6e5; color: var(--jce-orange); }
					.jce-q-node.danger { background: #fff1f2; color: var(--jce-red); }
					.jce-q-pill.fai { background: #eaf3ff; color: #07549f; }
					.jce-q-manual-node-list {
						display: flex;
						flex-wrap: wrap;
						gap: 6px;
						margin: 4px 0 10px;
					}
					.jce-q-node-chip {
						min-height: 34px;
						display: inline-flex;
						align-items: center;
						gap: 7px;
						padding: 5px 9px;
						border: 1px solid rgba(0, 113, 227, 0.18);
						border-radius: 8px;
						background: #f2f8ff;
						color: #07549f;
					}
					.jce-q-node-chip b,
					.jce-q-node-chip em {
						font-size: 12px;
						font-style: normal;
						font-weight: 800;
						line-height: 1.15;
					}
					.jce-q-node-chip em {
						color: var(--jce-muted);
					}
					.jce-q-focus-shell {
					--toolbar-height: 58px;
					width: 100%;
					height: 100dvh;
					max-height: 100dvh;
					display: flex;
					flex-direction: column;
					background: var(--jce-bg);
					overflow: hidden;
					overscroll-behavior: none;
					touch-action: pan-x pan-y;
				}
				.jce-q-focus-shell:fullscreen,
				.jce-q-focus-shell.fullscreen {
					width: 100vw;
					height: 100dvh;
					max-height: 100dvh;
				}
				.jce-q-focus-toolbar {
					min-height: var(--toolbar-height);
					flex: 0 0 auto;
					position: sticky;
					top: 0;
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 10px;
					padding: max(7px, env(safe-area-inset-top)) 10px 7px;
					background: rgba(250, 250, 252, 0.88);
					backdrop-filter: saturate(1.6) blur(22px);
					border-bottom: 1px solid var(--jce-line);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05);
					z-index: 20;
				}
				.jce-q-toolbar-left,
				.jce-q-toolbar-actions,
				.jce-q-nav-buttons,
				.jce-q-action-row,
				.jce-q-drawing-actions,
				.jce-q-button-group {
					display: flex;
					align-items: center;
					gap: 8px;
					min-width: 0;
				}
				.jce-q-toolbar-actions {
					flex-wrap: nowrap;
					justify-content: flex-end;
					flex: 0 0 auto;
				}
				.jce-q-action-row { flex-wrap: wrap; justify-content: flex-end; }
				.jce-q-drawing-actions {
					flex-wrap: nowrap;
					justify-content: flex-end;
					overflow-x: auto;
					-webkit-overflow-scrolling: touch;
				}
				.jce-q-back-button,
				.jce-q-icon-button,
				.jce-q-bar-button,
				.jce-q-small-button {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					min-height: 34px;
					border: 1px solid transparent;
					border-radius: 8px;
					background: #e9e9ee;
					color: var(--jce-text);
					padding: 0 10px;
					font-weight: 700;
					line-height: 1;
					white-space: nowrap;
					transition: background .16s ease, border-color .16s ease, color .16s ease;
				}
				.jce-q-icon-button {
					min-width: 34px;
					padding: 0 9px;
				}
				.jce-q-bar-button.primary,
				.jce-q-small-button.primary {
					background: var(--jce-blue);
					color: #fff;
				}
				.jce-q-bar-button.warn,
				.jce-q-small-button.warn {
					background: #ffb340;
					color: #3b2200;
				}
					.jce-q-bar-button.danger,
					.jce-q-small-button.danger {
						background: #fff1f2;
						color: var(--jce-red);
					}
				.jce-q-bar-button.subtle {
					background: transparent;
					border-color: var(--jce-line-soft);
					color: var(--jce-blue);
				}
				.jce-q-small-button.icon {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 32px;
					min-width: 32px;
					padding: 0;
				}
				.jce-q-small-button.icon svg {
					width: 15px;
					height: 15px;
					stroke-width: 2;
				}
				.jce-q-svg-icon {
					width: 16px;
					height: 16px;
					flex: 0 0 auto;
				}
				.jce-q-toolbar-status {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					min-width: 34px;
					min-height: 28px;
					padding: 0 9px;
					border-radius: 999px;
					background: #f2f2f7;
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 850;
					white-space: nowrap;
				}
				.jce-q-toolbar-status.ok {
					background: #ecf9f0;
					color: var(--jce-green);
				}
				.jce-q-toolbar-status.danger {
					background: #fff1f2;
					color: var(--jce-red);
				}
				.jce-q-back-button:hover,
				.jce-q-icon-button:hover,
				.jce-q-bar-button:hover,
					.jce-q-small-button:hover {
						border-color: rgba(0, 113, 227, 0.24);
					}
					.jce-q-bar-button:disabled,
					.jce-q-small-button:disabled {
						opacity: .52;
						cursor: not-allowed;
					}
				.jce-q-focus-title {
					min-width: 0;
					flex: 1 1 auto;
				}
				.jce-q-focus-title span,
				.jce-q-focus-title em {
					display: block;
					color: var(--jce-muted);
					font-size: 12px;
					font-style: normal;
					line-height: 1.35;
				}
				.jce-q-focus-title b {
					display: block;
					font-size: 15px;
					line-height: 1.2;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
					max-width: min(40vw, 520px);
				}
				.jce-q-workbench {
					flex: 1;
					min-height: 0;
					display: grid;
					grid-template-columns: minmax(0, calc(100% - var(--drawing-width) - 12px)) 12px minmax(0, var(--drawing-width));
					overflow: hidden;
					overscroll-behavior: none;
				}
				.jce-q-workbench.drawing-hidden {
					grid-template-columns: minmax(0, 1fr);
				}
				.jce-q-workbench.drawing-hidden .jce-q-split-resizer,
				.jce-q-workbench.drawing-hidden .jce-q-drawing-pane {
					display: none;
				}
				.jce-q-inspection-pane {
					min-width: 0;
					overflow: auto;
					padding: 10px;
					-webkit-overflow-scrolling: touch;
					overscroll-behavior: contain;
					touch-action: pan-x pan-y;
				}
				.jce-q-drawing-pane {
					min-width: 0;
					display: flex;
					flex-direction: column;
					background: #fff;
					overflow: hidden;
					overscroll-behavior: contain;
				}
				.jce-q-split-resizer {
					cursor: col-resize;
					touch-action: none;
					background: transparent;
					position: relative;
				}
				.jce-q-split-resizer:before {
					content: "";
					position: absolute;
					inset: 12px 4px;
					border-radius: 999px;
					background: #d1d1d6;
				}
				.jce-q-split-resizer.active:before { background: var(--jce-blue); }
				.jce-q-mobile-tabs { display: none; }
				.jce-q-panel {
					margin-bottom: 10px;
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: var(--jce-surface-soft);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.04);
				}
				.jce-q-section-head {
					align-items: center;
					margin-bottom: 8px;
				}
				.jce-q-section-head > div:not(.jce-q-section-actions) {
					min-width: 0;
					flex: 1 1 auto;
				}
				.jce-q-section-actions {
					flex: 0 0 auto;
					margin-left: auto;
					display: inline-flex;
					align-items: center;
					justify-content: flex-end;
					gap: 8px;
					min-width: 0;
				}
				.jce-q-section-head > div > b {
					display: block;
					margin-top: 2px;
					font-size: 14px;
					line-height: 1.25;
					overflow-wrap: anywhere;
				}
				.jce-q-muted {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
				}
				.jce-q-info-grid,
				.jce-q-sample-table {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
					gap: 0;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					overflow: hidden;
					background: #fff;
				}
				.jce-q-sample-table { grid-template-columns: repeat(2, minmax(0, 1fr)); }
				.jce-q-sample-control {
					min-width: 0;
					padding: 8px 10px;
					background: #fff;
				}
				.jce-q-sample-control .frappe-control,
				.jce-q-sample-control .input-max-width {
					max-width: none;
					margin: 0;
				}
				.jce-q-sample-control .control-input-wrapper,
				.jce-q-defect-control .control-input-wrapper {
					background: transparent;
				}
				.jce-q-sample-control .form-group,
				.jce-q-sample-control .link-field,
				.jce-q-defect-control .form-group,
				.jce-q-defect-control .link-field {
					margin-bottom: 0;
				}
				.jce-q-sample-control .form-control,
				.jce-q-sample-control .awesomplete input,
				.jce-q-defect-control .form-control,
				.jce-q-defect-control .awesomplete input {
					height: 36px;
					min-height: 36px;
					background: #f5f5f7 !important;
					border-color: #d2d2d7;
					border-radius: 8px;
					box-shadow: none;
				}
				.jce-q-sample-control .control-label,
				.jce-q-defect-control .control-label {
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 700;
					margin-bottom: 4px;
				}
				.jce-q-info-item {
					min-width: 0;
					padding: 8px 10px;
					background: #fff;
				}
				.jce-q-info-item b {
					display: block;
					margin-top: 3px;
					font-size: 13px;
					line-height: 1.3;
					overflow-wrap: anywhere;
				}
				.jce-q-decision-layout {
					display: grid;
					grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
					gap: 12px;
				}
				.jce-q-result-controls {
					display: grid;
					grid-template-columns: minmax(108px, .45fr) minmax(132px, 1fr);
					gap: 8px;
					align-items: flex-end;
				}
				.jce-q-system-result {
					display: grid;
					grid-template-columns: repeat(4, minmax(0, 1fr));
					gap: 0;
					margin-top: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					overflow: hidden;
					background: #fff;
				}
				.jce-q-field {
					display: grid;
					gap: 6px;
					margin: 0;
					min-width: 0;
				}
				.jce-q-field > span { text-transform: none; }
				.jce-q-switch {
					position: relative;
					display: flex;
					align-items: center;
					gap: 8px;
					min-height: 36px;
					margin: 0;
					font-weight: 700;
				}
				.jce-q-switch input {
					position: absolute;
					opacity: 0;
					pointer-events: none;
				}
				.jce-q-switch > span {
					position: relative;
					display: block;
					flex: 0 0 auto;
					width: 40px;
					height: 24px;
					border-radius: 999px;
					background: #d1d1d6;
					transition: background .16s ease;
				}
				.jce-q-switch > span:before {
					content: "";
					position: absolute;
					top: 50%;
					left: 3px;
					width: 20px;
					height: 20px;
					border-radius: 999px;
					background: #fff;
					box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
					transition: transform .16s ease;
					transform: translateY(-50%);
				}
				.jce-q-switch input:checked + span {
					background: var(--jce-blue);
				}
				.jce-q-switch input:checked + span:before {
					transform: translate(16px, -50%);
				}
				.jce-q-switch input:disabled + span {
					opacity: .55;
				}
				.jce-q-readonly-link {
					display: flex;
					align-items: center;
					padding: 0 12px;
					font-weight: 700;
				}
				.jce-q-remarks {
					min-height: 76px;
					resize: vertical;
				}
				.jce-q-warning {
					padding: 9px 11px;
					margin-bottom: 10px;
					border: 1px solid rgba(182, 90, 0, 0.18);
					border-radius: 8px;
					background: #fff7ed;
					color: var(--jce-orange);
					font-weight: 700;
				}
				.jce-q-warning.danger {
					border-color: rgba(192, 31, 47, 0.18);
					background: #fff1f2;
					color: var(--jce-red);
				}
				.jce-q-alert-banner {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 10px;
					margin-bottom: 10px;
					padding: 9px 10px;
					border: 1px solid rgba(192, 31, 47, 0.18);
					border-radius: 8px;
					background: #fff7f8;
					color: var(--jce-text);
				}
				.jce-q-pwa-hint {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 10px;
					margin-bottom: 10px;
					padding: 9px 10px;
					border: 1px solid rgba(0, 113, 227, 0.18);
					border-radius: 8px;
					background: #eef6ff;
					color: var(--jce-text);
				}
				.jce-q-alert-banner b,
				.jce-q-alert-banner span,
				.jce-q-pwa-hint b,
				.jce-q-pwa-hint span {
					display: block;
					line-height: 1.35;
				}
				.jce-q-alert-banner span,
				.jce-q-pwa-hint span {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
				}
				.jce-q-quick-actions .jce-q-section-head {
					align-items: center;
					margin-bottom: 0;
				}
				.jce-q-quick-actions .jce-q-section-head > div > b {
					color: var(--jce-red);
					font-size: 13px;
				}
				.jce-q-quick-actions .jce-q-small-button svg {
					margin-right: 6px;
				}
				.jce-q-patrol-nav-main {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
				}
				.jce-q-patrol-nav-main > div:first-child {
					min-width: 0;
				}
				.jce-q-patrol-nav-main span {
					display: block;
					color: var(--jce-muted);
					font-size: 11px;
					font-weight: 800;
					text-transform: uppercase;
				}
				.jce-q-patrol-nav-main b {
					display: block;
					margin-top: 2px;
					font-size: 17px;
					line-height: 1.2;
				}
				.jce-q-patrol-nav-actions {
					display: inline-flex;
					align-items: center;
					justify-content: flex-end;
					gap: 6px;
					flex: 0 0 auto;
				}
				.jce-q-patrol-nav-actions button:disabled {
					opacity: .42;
					cursor: not-allowed;
				}
				.jce-q-patrol-nav-meta {
					display: flex;
					align-items: center;
					gap: 10px;
					flex-wrap: wrap;
					margin-top: 8px;
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 800;
				}
				.jce-q-patrol-history-list {
					display: grid;
					gap: 8px;
				}
				.jce-q-patrol-history-row {
					display: grid;
					grid-template-columns: 82px 64px minmax(112px, .8fr) minmax(0, 1.4fr);
					gap: 8px;
					align-items: center;
					width: 100%;
					min-height: 44px;
					padding: 8px 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 10px;
					background: #fff;
					text-align: left;
				}
				.jce-q-patrol-history-row.active {
					border-color: rgba(0, 113, 227, .32);
					box-shadow: 0 0 0 3px rgba(0, 113, 227, .10);
				}
				.jce-q-patrol-history-row span,
				.jce-q-patrol-history-row b,
				.jce-q-patrol-history-row em,
				.jce-q-patrol-history-row small {
					min-width: 0;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-patrol-history-row span,
				.jce-q-patrol-history-row em {
					color: var(--jce-muted);
					font-size: 12px;
					font-style: normal;
					font-weight: 800;
				}
				.jce-q-patrol-history-row b {
					font-size: 13px;
					font-weight: 850;
				}
				.jce-q-patrol-history-row small {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
				}
				.jce-q-patrol-history-row.ok b { color: var(--jce-green); }
				.jce-q-patrol-history-row.warn b { color: var(--jce-orange); }
				.jce-q-patrol-history-row.danger b { color: var(--jce-red); }
				.jce-q-disposition-panel {
					border-color: rgba(192, 31, 47, 0.14);
				}
				.jce-q-disposition-grid {
					display: grid;
					grid-template-columns: repeat(3, minmax(0, 1fr));
					gap: 0;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					overflow: hidden;
					background: #fff;
				}
				.jce-q-disposition-note {
					margin-top: 8px;
					padding: 8px 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
				}
				.jce-q-disposition-note span,
				.jce-q-disposition-help {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 800;
				}
				.jce-q-disposition-note b {
					display: block;
					margin-top: 4px;
					line-height: 1.4;
					overflow-wrap: anywhere;
				}
				.jce-q-disposition-actions {
					display: flex;
					align-items: center;
					justify-content: flex-end;
					gap: 8px;
					flex-wrap: wrap;
					margin-top: 10px;
				}
				.jce-q-disposition-help {
					margin-top: 10px;
				}
				.jce-q-alert-list {
					display: grid;
					gap: 6px;
				}
				.jce-q-alert-row {
					display: grid;
					grid-template-columns: 74px minmax(0, 1fr);
					gap: 10px;
					align-items: center;
					width: 100%;
					min-height: 38px;
					padding: 7px 9px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
					text-align: left;
				}
				.jce-q-alert-row span {
					color: var(--jce-red);
					font-size: 12px;
					font-weight: 800;
				}
				.jce-q-alert-row b {
					min-width: 0;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					font-size: 13px;
				}
				.jce-q-dialog-summary {
					padding: 10px 12px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff7f8;
					color: var(--jce-red);
					font-weight: 750;
					line-height: 1.45;
				}
				.jce-q-sheet-backdrop {
					position: fixed;
					inset: 0;
					z-index: 2147483100;
					display: grid;
					place-items: center;
					padding: 18px;
					background: rgba(0, 0, 0, .24);
					backdrop-filter: blur(12px);
				}
				.jce-q-sheet {
					width: min(520px, calc(100vw - 28px));
					max-height: calc(100dvh - 28px);
					display: flex;
					flex-direction: column;
					border: 1px solid rgba(255, 255, 255, .7);
					border-radius: 18px;
					background: rgba(250, 250, 252, .96);
					box-shadow: 0 24px 80px rgba(0, 0, 0, .24);
					overflow: hidden;
				}
				.jce-q-sheet-head,
				.jce-q-sheet-foot {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 10px;
					padding: 12px;
					border-bottom: 1px solid var(--jce-line-soft);
				}
				.jce-q-sheet-head {
					position: relative;
					justify-content: flex-start;
					min-height: 58px;
					padding-right: 60px;
				}
				.jce-q-sheet-head b {
					flex: 1 1 auto;
					min-width: 0;
					font-size: 17px;
					line-height: 1.2;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-sheet-head [data-sheet-close] {
					position: absolute;
					top: 50%;
					right: 12px;
					margin: 0;
					transform: translateY(-50%);
				}
				.jce-q-sheet-body {
					display: grid;
					gap: 12px;
					padding: 14px;
					overflow: auto;
				}
				.jce-q-sheet-foot {
					justify-content: flex-end;
					border-top: 1px solid var(--jce-line-soft);
					border-bottom: 0;
				}
				.jce-q-sheet-options {
					display: grid;
					gap: 8px;
				}
				.jce-q-sheet-options button {
					min-height: 48px;
					display: flex;
					align-items: center;
					gap: 10px;
					padding: 0 12px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 12px;
					background: #fff;
					font-weight: 800;
					text-align: left;
				}
				.jce-q-sheet-options button:disabled {
					opacity: .52;
					cursor: not-allowed;
				}
				.jce-q-sheet-field {
					display: grid;
					gap: 6px;
					margin: 0;
				}
				.jce-q-sheet-field span {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 800;
				}
				.jce-q-sheet-field input,
				.jce-q-sheet-field textarea {
					width: 100%;
					min-height: 38px;
					padding: 8px 10px;
					border: 1px solid #d2d2d7;
					border-radius: 10px;
					background: #fff;
					box-shadow: none;
				}
				.jce-q-sheet-field textarea {
					min-height: 92px;
					resize: vertical;
				}
				.jce-q-alert-dialog h5 {
					margin: 14px 0 8px;
					font-weight: 800;
				}
				.jce-q-readings {
					overflow-x: auto;
					-webkit-overflow-scrolling: touch;
				}
				.jce-q-reading-matrix {
					display: grid;
					gap: 6px;
					min-width: max(100%, calc(260px + var(--sample-count) * 96px));
				}
				.jce-q-reading-matrix-row {
					display: grid;
					gap: 8px;
					align-items: center;
					padding: 8px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
				}
				.jce-q-reading-matrix-row.head {
					position: sticky;
					top: 0;
					z-index: 2;
					background: #f5f5f7;
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 800;
				}
				.jce-q-reading-spec b,
				.jce-q-reading-spec span { display: block; }
				.jce-q-reading-spec b {
					font-size: 14px;
					line-height: 1.3;
					overflow-wrap: anywhere;
				}
				.jce-q-reading-spec span {
					margin-top: 4px;
					color: var(--jce-muted);
					font-size: 12px;
					line-height: 1.3;
					overflow-wrap: anywhere;
				}
				.jce-q-reading-method {
					color: var(--jce-blue);
					font-weight: 800;
				}
				.jce-q-reading-matrix-row input { width: 100%; padding: 8px; }
				.jce-q-defects,
				.jce-q-photos { display: grid; gap: 10px; }
				.jce-q-defect-row {
					display: grid;
					grid-template-columns: minmax(180px, 1.1fr) minmax(90px, .45fr) minmax(180px, 1.3fr) auto;
					gap: 8px;
					align-items: end;
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
				}
				.jce-q-defect-row > .jce-q-small-button {
					align-self: end;
					height: 36px;
				}
				.jce-q-defect-name {
					align-self: end;
					min-height: 36px;
					display: inline-flex;
					align-items: center;
				}
				.jce-q-defect-description {
					margin-top: 4px;
					min-height: 16px;
					color: var(--jce-muted);
					font-size: 12px;
					line-height: 1.3;
					overflow-wrap: anywhere;
				}
				.jce-q-oqc-shell .jce-q-list-header {
					align-items: center;
				}
				.jce-terminal-fullscreen .jce-q-task-shell.jce-q-oqc-shell {
					display: grid;
					grid-template-rows: auto auto minmax(0, 1fr);
					overflow: hidden;
				}
				.jce-q-oqc-scroll {
					display: contents;
				}
				.jce-q-filter-panel.oqc {
					align-items: flex-end;
				}
				.jce-q-oqc-toolbar {
					display: grid;
					grid-template-columns: repeat(6, minmax(140px, 1fr));
					gap: 8px;
					width: 100%;
				}
				.jce-q-oqc-workspace {
					display: grid;
					grid-template-columns: minmax(280px, 370px) minmax(0, 1fr);
					gap: 10px;
					min-height: 0;
				}
				.jce-terminal-fullscreen .jce-q-oqc-workspace {
					height: 100%;
				}
				.jce-q-oqc-list-panel,
				.jce-q-oqc-items-panel {
					display: flex;
					flex-direction: column;
					min-height: min(66dvh, 620px);
					margin-bottom: 0;
					overflow: hidden;
				}
				.jce-terminal-fullscreen .jce-q-oqc-list-panel,
				.jce-terminal-fullscreen .jce-q-oqc-items-panel {
					height: 100%;
					min-height: 0;
				}
				.jce-q-oqc-list-panel .jce-q-section-head,
				.jce-q-oqc-items-panel .jce-q-section-head {
					flex: 0 0 auto;
				}
				.jce-q-oqc-delivery-list,
				.jce-q-oqc-items {
					display: grid;
					gap: 8px;
					flex: 1 1 auto;
					min-height: 0;
					overflow-y: auto;
					overflow-x: hidden;
					padding-right: 2px;
					overscroll-behavior: contain;
					-webkit-overflow-scrolling: touch;
				}
				.jce-q-oqc-list {
					display: grid;
					gap: 8px;
					max-height: none;
					overflow: visible;
				}
				.jce-q-oqc-row {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
				}
				.jce-q-oqc-delivery-row {
					width: 100%;
					text-align: left;
					cursor: pointer;
					transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
				}
				.jce-q-oqc-delivery-row.active {
					border-color: rgba(0, 113, 227, 0.36);
					box-shadow: inset 3px 0 0 var(--jce-blue);
				}
				.jce-q-oqc-delivery-row:hover {
					transform: translateY(-1px);
					border-color: rgba(0, 113, 227, 0.24);
				}
				.jce-q-oqc-item-row {
					align-items: flex-start;
				}
				.jce-q-oqc-item-main {
					min-width: 0;
				}
				.jce-q-oqc-customer-code {
					color: #07549f;
					font-size: 12px;
					font-weight: 760;
				}
				.jce-q-oqc-item-main .warn {
					color: var(--jce-orange);
					font-weight: 750;
				}
				.jce-q-oqc-item-actions {
					display: flex;
					align-items: center;
					justify-content: flex-end;
					flex-wrap: wrap;
					gap: 6px;
				}
				.jce-q-oqc-row > div > b,
				.jce-q-oqc-row > div > span,
				.jce-q-oqc-row > div > em {
					display: block;
				}
				.jce-q-oqc-row > div > em {
					color: var(--jce-muted);
					font-style: normal;
					font-size: 12px;
				}
				.jce-q-photos { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
				.jce-q-photo {
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
					display: grid;
					gap: 8px;
				}
				.jce-q-photo img {
					width: 100%;
					height: 118px;
					object-fit: cover;
					border-radius: 8px;
				}
				.jce-q-photo > .jce-q-small-button {
					justify-self: end;
				}
				.jce-q-drawing-toolbar {
					min-height: 44px;
					padding: 6px 8px;
					background: rgba(250, 250, 252, 0.90);
					backdrop-filter: saturate(1.4) blur(18px);
					border-bottom: 1px solid var(--jce-line);
					z-index: 5;
				}
				.jce-q-drawing-title {
					min-width: 0;
				}
				.jce-q-drawing-title b {
					display: block;
					max-width: 190px;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-button-group {
					flex: 0 0 auto;
					gap: 2px;
					padding: 2px;
					border-radius: 8px;
					background: #f2f2f7;
				}
				.jce-q-button-group .jce-q-small-button {
					min-height: 30px;
					border-radius: 6px;
					background: transparent;
				}
				.jce-q-button-group span {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					min-width: 48px;
					padding: 0 6px;
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
				}
				.jce-q-pdf-stage,
				.jce-q-image-viewer {
					flex: 1;
					min-height: 0;
					overflow: auto;
					display: grid;
					place-items: start center;
					background: #e5e5ea;
					padding: 12px;
					-webkit-overflow-scrolling: touch;
					overscroll-behavior: contain;
					touch-action: pan-x pan-y;
				}
				.jce-q-pdf-canvas {
					background: #fff;
					box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
				}
				.jce-q-pdf-loading,
				.jce-q-drawing-empty {
					place-self: center;
					color: var(--jce-muted);
					font-weight: 700;
				}
				.jce-q-image-viewer img {
					max-width: none;
					height: auto;
					background: #fff;
					box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
				}
				.jce-q-pill {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					min-height: 28px;
					padding: 0 9px;
					border-radius: 999px;
					background: #e9e9ee;
					color: var(--jce-text);
					font-size: 12px;
					font-weight: 800;
					white-space: nowrap;
				}
					.jce-q-pill.ok { background: #ecf9f0; color: var(--jce-green); }
					.jce-q-pill.warn { background: #fff6e5; color: var(--jce-orange); }
					.jce-q-pill.danger { background: #fff1f2; color: var(--jce-red); }
					.jce-q-pill.fai { background: #eaf3ff; color: #07549f; }
					.jce-q-task-drawer {
					position: fixed;
					inset: 0 auto 0 0;
					width: min(420px, 86vw);
					background: rgba(250, 250, 252, 0.96);
					backdrop-filter: saturate(1.4) blur(22px);
					transform: translateX(-105%);
					transition: transform .22s ease;
					z-index: 80;
					box-shadow: 18px 0 50px rgba(0, 0, 0, .18);
					display: flex;
					flex-direction: column;
				}
				.jce-q-task-drawer.open { transform: translateX(0); }
				.jce-q-drawer-head {
					position: relative;
					min-height: 64px;
					display: flex;
					align-items: center;
					justify-content: flex-start;
					padding: 10px 58px 10px 14px;
					border-bottom: 1px solid var(--jce-line);
				}
				.jce-q-drawer-head b {
					min-width: 0;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-drawer-head [data-action="close-drawer"] {
					position: absolute;
					top: 50%;
					right: 14px;
					margin: 0;
					transform: translateY(-50%);
				}
				.jce-q-drawer-list {
					padding: 12px;
					overflow: auto;
					display: grid;
					gap: 10px;
				}
				.jce-q-drawer-backdrop {
					position: fixed;
					inset: 0;
					background: rgba(0, 0, 0, .18);
					opacity: 0;
					pointer-events: none;
					transition: opacity .2s ease;
					z-index: 70;
				}
				.jce-q-drawer-backdrop.open {
					opacity: 1;
					pointer-events: auto;
				}
				.jce-q-camera-wrap {
					display: grid;
					gap: 8px;
					height: 100%;
					min-height: 0;
				}
				.jce-q-camera-stage {
					position: relative;
					width: min(100%, 920px);
					height: min(58dvh, 680px);
					max-height: calc(100dvh - 230px);
					margin: 0 auto;
					aspect-ratio: 4 / 3;
					overflow: hidden;
					border-radius: 8px;
					background: #000;
					border: 1px solid var(--jce-line-soft);
				}
				.jce-q-camera-video,
				.jce-q-camera-canvas,
				.jce-q-annotation-canvas {
					width: 100%;
					height: 100%;
					object-fit: contain;
					display: block;
					background: #000;
				}
				.jce-q-annotation-canvas {
					position: absolute;
					inset: 0;
					z-index: 3;
					background: transparent;
					touch-action: none;
					cursor: crosshair;
				}
				.jce-q-camera-video[hidden],
				.jce-q-camera-canvas[hidden],
				.jce-q-annotation-canvas[hidden],
				.jce-q-camera-shot[hidden],
				.jce-q-camera-retake[hidden],
				.jce-q-camera-tools[hidden] {
					display: none;
				}
				.jce-q-camera-badge {
					position: absolute;
					right: 12px;
					bottom: 12px;
					z-index: 5;
					max-width: calc(100% - 96px);
					padding: 7px 10px;
					border-radius: 8px;
					background: rgba(0, 0, 0, .56);
					color: #fff;
					font-size: 12px;
					font-weight: 700;
					line-height: 1.35;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.jce-q-camera-shot,
				.jce-q-camera-retake {
					position: absolute;
					z-index: 6;
					left: 50%;
					bottom: 14px;
					width: 54px;
					height: 54px;
					border: 2px solid rgba(255, 255, 255, .85);
					border-radius: 999px;
					background: rgba(255, 255, 255, .92);
					color: #111;
					box-shadow: 0 10px 28px rgba(0, 0, 0, .28);
					transform: translateX(-50%);
					display: inline-flex;
					align-items: center;
					justify-content: center;
				}
				.jce-q-camera-shot svg,
				.jce-q-camera-retake svg {
					width: 22px;
					height: 22px;
				}
				.jce-q-camera-retake {
					left: auto;
					right: 14px;
					transform: none;
					width: 40px;
					height: 40px;
				}
				.jce-q-camera-hint {
					color: var(--jce-muted);
					font-size: 12px;
					font-weight: 700;
					text-align: center;
				}
				.jce-q-camera-tools {
					display: flex;
					align-items: center;
					justify-content: center;
					gap: 8px;
					flex-wrap: wrap;
				}
				.jce-q-camera-tools .jce-q-small-button {
					min-width: 42px;
					height: 36px;
				}
				.jce-q-camera-tools .jce-q-small-button.active {
					background: #111;
					color: #fff;
				}
				.jce-q-empty {
					padding: 28px;
					text-align: center;
					color: var(--jce-muted);
				}
				.jce-q-empty.compact {
					padding: 18px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: #fff;
				}
				@media (max-width: 1100px) and (orientation: landscape) {
					.jce-q-focus-toolbar {
						gap: 8px;
						padding-left: 8px;
						padding-right: 8px;
					}
					.jce-q-nav-buttons {
						gap: 6px;
					}
					.jce-q-back-button,
					.jce-q-icon-button,
					.jce-q-bar-button,
					.jce-q-small-button {
						min-height: 32px;
						padding-left: 8px;
						padding-right: 8px;
					}
					.jce-q-small-button.icon {
						width: 30px;
						min-width: 30px;
						padding: 0;
					}
					.jce-q-focus-title b {
						max-width: 300px;
						font-size: 14px;
					}
					.jce-q-focus-title em {
						display: none;
					}
					.jce-q-toolbar-actions {
						gap: 6px;
					}
					.jce-q-toolbar-status {
						min-height: 26px;
						padding: 0 8px;
					}
					.jce-q-inspection-pane {
						padding: 8px;
					}
					.jce-q-panel {
						margin-bottom: 8px;
						padding: 8px;
					}
					.jce-q-decision-layout {
						grid-template-columns: 1fr;
						gap: 8px;
					}
					.jce-q-drawing-title b {
						max-width: 120px;
					}
				}
				@media (max-width: 900px), (orientation: portrait) {
					.jce-q-toolbar {
						grid-template-columns: 1fr;
					}
					.jce-q-focus-toolbar {
						align-items: stretch;
						flex-direction: column;
						gap: 8px;
					}
					.jce-q-toolbar-left,
					.jce-q-toolbar-actions { justify-content: space-between; width: 100%; }
					.jce-q-nav-buttons { flex: 0 0 auto; }
					.jce-q-focus-title b { max-width: 100%; }
					.jce-q-mobile-tabs {
						display: grid;
						grid-template-columns: 1fr 1fr;
						gap: 6px;
						padding: 8px;
						background: var(--jce-bg);
					}
					.jce-q-mobile-tabs.single {
						grid-template-columns: 1fr;
					}
					.jce-q-mobile-tabs button {
						min-height: 44px;
						border: 1px solid transparent;
						border-radius: 8px;
						background: #e9e9ee;
						font-weight: 800;
					}
					.jce-q-mobile-tabs button.active { background: var(--jce-text); color: #fff; }
					.jce-q-workbench {
						display: block;
						overflow: hidden;
					}
					.jce-q-split-resizer { display: none; }
					.jce-q-inspection-pane,
					.jce-q-drawing-pane {
						height: 100%;
					}
					.jce-q-workbench.pane-inspection .jce-q-drawing-pane,
					.jce-q-workbench.pane-drawing .jce-q-inspection-pane { display: none; }
					.jce-q-decision-layout,
					.jce-q-info-grid,
					.jce-q-sample-table,
					.jce-q-result-controls,
					.jce-q-disposition-grid,
					.jce-q-defect-row { grid-template-columns: 1fr; }
					.jce-q-oqc-toolbar {
						grid-template-columns: repeat(2, minmax(0, 1fr));
					}
					.jce-q-oqc-workspace {
						grid-template-columns: 1fr;
						grid-template-rows: minmax(170px, .42fr) minmax(0, 1fr);
					}
					.jce-q-system-result { grid-template-columns: repeat(2, minmax(0, 1fr)); }
					.jce-q-toolbar-actions .jce-q-bar-button { flex: 1 1 calc(50% - 8px); }
					.jce-q-patrol-history-row { grid-template-columns: 72px 54px minmax(0, 1fr); }
					.jce-q-patrol-history-row small { grid-column: 1 / -1; }
					.jce-q-drawing-toolbar {
						align-items: flex-start;
						flex-direction: column;
					}
					.jce-q-drawing-actions { justify-content: flex-start; }
				}
					@media (max-width: 640px) {
						.jce-q-list-header {
							align-items: stretch;
							flex-direction: column;
						}
						.jce-q-entry-panel {
							align-items: stretch;
						}
						.jce-q-entry-action {
							flex: 1 1 calc(50% - 4px);
							min-height: 44px;
						}
						.jce-q-list-metrics {
							justify-content: flex-start;
						}
					.jce-q-task-list { grid-template-columns: 1fr; }
					.jce-q-task-meta-grid,
					.jce-q-node-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
					.jce-q-toolbar-left {
						align-items: flex-start;
						flex-direction: column;
					}
					.jce-q-nav-buttons { width: 100%; }
					.jce-q-nav-buttons button { flex: 1; }
					.jce-q-toolbar-actions .jce-q-bar-button { flex-basis: 100%; }
					.jce-q-oqc-toolbar {
						grid-template-columns: 1fr;
					}
					.jce-q-oqc-row,
					.jce-q-oqc-item-actions {
						align-items: stretch;
						flex-direction: column;
					}
					.jce-terminal-fullscreen .jce-q-task-shell.jce-q-oqc-shell {
						display: flex;
						flex-direction: column;
						overflow-y: auto;
						overflow-x: hidden;
						-webkit-overflow-scrolling: touch;
					}
					.jce-q-oqc-shell .jce-q-filter-panel.oqc {
						margin-bottom: 8px;
					}
					.jce-q-oqc-shell .jce-q-oqc-toolbar {
						grid-template-columns: repeat(2, minmax(0, 1fr));
						gap: 7px;
					}
					.jce-q-oqc-shell .jce-q-oqc-workspace {
						display: flex;
						flex: 0 0 auto;
						flex-direction: column;
						gap: 8px;
						height: auto;
						min-height: 0;
					}
					.jce-q-oqc-shell .jce-q-oqc-list-panel {
						flex: 0 0 auto;
						min-height: 180px;
						max-height: 34dvh;
					}
					.jce-q-oqc-shell .jce-q-oqc-items-panel {
						flex: 0 0 auto;
						min-height: 260px;
						overflow: visible;
					}
					.jce-q-oqc-shell .jce-q-oqc-items {
						overflow: visible;
					}
				}
				@media (max-width: 640px) and (orientation: portrait) {
					.jce-q-task-shell {
						padding: max(7px, env(safe-area-inset-top)) 8px max(12px, env(safe-area-inset-bottom));
					}
					.jce-q-task-shell:not(.jce-q-oqc-shell) .jce-q-list-header {
						align-items: flex-start;
						flex-direction: row;
						gap: 7px;
						justify-content: space-between;
						margin-bottom: 7px;
					}
					.jce-q-task-shell:not(.jce-q-oqc-shell) .jce-q-list-header > div:first-child {
						flex: 1 1 auto;
						min-width: 0;
					}
					.jce-q-list-header h2 {
						font-size: 20px;
					}
					.jce-q-task-shell:not(.jce-q-oqc-shell) .jce-q-list-actions {
						align-items: flex-start;
						flex: 0 0 auto;
						justify-content: flex-end;
						margin-left: auto;
						min-width: 34px;
					}
					.jce-q-task-shell:not(.jce-q-oqc-shell) .jce-q-list-actions .jce-q-fullscreen-button {
						margin-left: auto;
					}
					.jce-q-filter-panel:not(.oqc) {
						margin-bottom: 8px;
						padding: 8px;
					}
					.jce-q-filter-head {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 8px;
						margin-bottom: 6px;
						width: 100%;
					}
					.jce-q-filter-head .jce-q-filter-title {
						flex: 1 1 auto;
						min-width: 0;
					}
					.jce-q-filter-panel:not(.oqc) .jce-q-mobile-filter-refresh {
						display: inline-flex !important;
						flex: 0 0 auto;
						margin-left: auto;
						width: 34px !important;
						min-width: 34px !important;
						height: 34px;
						min-height: 34px;
						border-radius: 999px;
					}
					.jce-q-filter-panel:not(.oqc) .jce-q-filter-action {
						display: none;
					}
					.jce-q-filter-panel:not(.oqc) .jce-q-toolbar {
						grid-template-columns: repeat(2, minmax(0, 1fr));
						gap: 7px;
						margin-top: 0;
					}
					.jce-q-filter-panel:not(.oqc) .jce-q-filter-posting_date {
						grid-column: 1 / -1;
					}
					.jce-q-filter .control-label {
						margin-bottom: 2px;
						font-size: 10px;
					}
					.jce-q-filter .form-control,
					.jce-q-field .form-control,
					.jce-q-reading-inputs input,
					.jce-q-reading-matrix-row input,
					.jce-q-readonly-link {
						height: 34px;
						min-height: 34px;
					}
					.jce-q-terminal input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),
					.jce-q-terminal textarea {
						font-size: 16px;
						touch-action: manipulation;
						-webkit-user-select: text;
						user-select: text;
					}
					.jce-q-focus-toolbar {
						min-height: 0;
						gap: 6px;
						padding: max(6px, env(safe-area-inset-top)) 8px 6px;
					}
					.jce-q-focus-toolbar .jce-q-toolbar-left {
						align-items: center;
						flex-direction: row;
						gap: 7px;
						width: 100%;
					}
					.jce-q-focus-toolbar .jce-q-toolbar-actions {
						width: 100%;
						justify-content: flex-start;
						gap: 5px;
						flex-wrap: nowrap;
						overflow-x: auto;
						padding-bottom: 1px;
						-webkit-overflow-scrolling: touch;
					}
					.jce-q-focus-toolbar .jce-q-toolbar-actions .jce-q-bar-button {
						flex: 0 0 auto;
						min-height: 32px;
						padding: 0 10px;
					}
					.jce-q-nav-buttons {
						width: auto;
						gap: 5px;
					}
					.jce-q-nav-buttons button {
						flex: 0 0 auto;
					}
					.jce-q-task-shell:not(.jce-q-oqc-shell) .jce-q-list-header .jce-q-small-button.icon,
					.jce-q-focus-toolbar .jce-q-small-button.icon,
					.jce-q-oqc-shell .jce-q-small-button.icon {
						width: 34px;
						min-width: 34px;
						min-height: 32px;
						border-radius: 999px;
						background: rgba(255, 255, 255, 0.76);
						border-color: rgba(0, 0, 0, 0.08);
						box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
						backdrop-filter: saturate(1.6) blur(18px);
						-webkit-backdrop-filter: saturate(1.6) blur(18px);
					}
					.jce-q-focus-title span,
					.jce-q-focus-title em {
						font-size: 10px;
						line-height: 1.25;
					}
					.jce-q-focus-title b {
						font-size: 14px;
						line-height: 1.18;
					}
					.jce-q-mobile-tabs {
						display: grid;
						grid-template-columns: 1fr 1fr;
						gap: 0;
						margin: 6px 8px;
						padding: 3px;
						border: 1px solid rgba(0, 0, 0, 0.06);
						border-radius: 999px;
						background: rgba(118, 118, 128, 0.14);
					}
					.jce-q-mobile-tabs.single {
						grid-template-columns: 1fr;
					}
					.jce-q-mobile-tabs button {
						min-height: 32px;
						border: 0;
						border-radius: 999px;
						background: transparent;
						color: var(--jce-muted);
						font-size: 13px;
						font-weight: 800;
					}
					.jce-q-mobile-tabs button.active {
						background: rgba(255, 255, 255, 0.94);
						color: var(--jce-text);
						box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
					}
					.jce-q-inspection-pane {
						padding: 8px;
					}
					.jce-terminal-fullscreen .jce-q-task-shell.jce-q-oqc-shell,
					.jce-q-task-shell.jce-q-oqc-shell {
						display: flex !important;
						flex-direction: column;
						height: 100dvh;
						max-height: 100dvh;
						overflow: hidden !important;
					}
					.jce-q-oqc-shell .jce-q-list-header {
						flex: 0 0 auto;
						align-items: center;
						flex-direction: row;
						gap: 7px;
						justify-content: space-between;
						margin-bottom: 6px;
					}
					.jce-q-oqc-shell .jce-q-toolbar-left {
						align-items: center;
						flex: 1 1 auto;
						flex-direction: row;
						gap: 7px;
						justify-content: flex-start;
						width: auto;
						min-width: 0;
					}
					.jce-q-oqc-shell .jce-q-toolbar-left > div:last-child {
						min-width: 0;
					}
					.jce-q-oqc-shell .jce-q-toolbar-left h2 {
						max-width: 100%;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
						font-size: 17px;
						line-height: 1.12;
					}
					.jce-q-oqc-shell .jce-q-toolbar-left .jce-q-eyebrow {
						font-size: 9px;
					}
					.jce-q-oqc-shell .jce-q-list-actions {
						flex: 0 0 auto;
						align-items: center;
						flex-direction: row;
						gap: 5px;
						justify-content: flex-end;
						margin-left: auto;
						width: auto;
					}
					.jce-q-oqc-shell .jce-q-list-actions .jce-q-small-button.primary {
						min-height: 32px;
						padding: 0 11px;
						border-radius: 999px;
					}
					.jce-q-oqc-scroll {
						display: block;
						flex: 1 1 auto;
						min-height: 0;
						overflow-y: auto;
						overflow-x: hidden;
						padding-bottom: max(10px, env(safe-area-inset-bottom));
						overscroll-behavior: contain;
						-webkit-overflow-scrolling: touch;
					}
					.jce-q-oqc-shell .jce-q-filter-panel.oqc {
						margin-bottom: 8px;
						padding: 8px;
					}
					.jce-q-oqc-shell .jce-q-oqc-toolbar {
						grid-template-columns: repeat(2, minmax(0, 1fr));
						gap: 7px;
						margin-top: 6px;
					}
					.jce-q-oqc-shell .jce-q-oqc-workspace {
						display: flex;
						flex-direction: column;
						gap: 8px;
						height: auto;
						min-height: 0;
					}
					.jce-q-oqc-shell .jce-q-oqc-list-panel {
						flex: 0 0 auto;
						min-height: 138px;
						max-height: 28dvh;
					}
					.jce-q-oqc-shell .jce-q-oqc-items-panel {
						flex: 0 0 auto;
						min-height: 260px;
						overflow: visible;
					}
					.jce-q-oqc-shell .jce-q-oqc-items {
						overflow: visible;
					}
					.jce-q-oqc-shell .jce-q-oqc-row {
						padding: 9px;
					}
				}
			</style>`).appendTo(document.head);
	}
}

function esc(value) {
	return frappe.utils.escape_html(String(value ?? ""));
}

function form_url(doctype, name) {
	const slug = frappe.router?.slug ? frappe.router.slug(doctype) : String(doctype).toLowerCase().replace(/\s+/g, "-");
	return `/app/${slug}/${encodeURIComponent(name)}`;
}

const JCE_ICON_ALIASES = {
	"alert-triangle": "es-solid-alert-triangle",
	camera: "es-line-camera",
	"chevron-left": "es-line-left-chevron",
	"chevron-right": "es-line-right-chevron",
	"external-link": "es-solid-external-link",
	"file-text": "es-line-select-file",
	list: "es-line-bullet-list",
	"maximize-2": "es-line-expand",
	"minimize-2": "shrink",
	"move-horizontal": "arrow-left-right",
	plus: "es-line-add",
	"refresh-cw": "es-line-reload",
	"trash-2": "delete",
	x: "es-small-close",
};

function icon_html(icon, size = "sm") {
	const icon_name = JCE_ICON_ALIASES[icon] || icon || "es-solid-alert-triangle";
	return frappe.utils.icon(icon_name, size, "", "", "jce-q-svg-icon", true);
}

function clean_value(value) {
	const text = strip_html(value).trim();
	return ["undefined", "null", "false"].includes(text.toLowerCase()) ? "" : text;
}

function strip_html(value) {
	const text = String(value ?? "");
	if (!text.includes("<")) return text;
	const holder = document.createElement("div");
	holder.innerHTML = text;
	return holder.textContent || holder.innerText || "";
}

function format_float(value) {
	return clean_value(frappe.format(value || 0, { fieldtype: "Float" }));
}

function clean_url(value) {
	const url = String(value ?? "").trim();
	if (!url || ["undefined", "null", "false"].includes(url.toLowerCase())) {
		return "";
	}
	return url;
}

function cint(value) {
	return parseInt(value || 0, 10) || 0;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, Number(value) || min));
}

function canvas_to_blob(canvas, type = "image/jpeg", quality = 0.9) {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) {
				resolve(blob);
			} else {
				reject(new Error("Unable to create image blob"));
			}
		}, type, quality);
	});
}

function render_inspection_photo(video, canvas, options = {}) {
	const source_width = video.videoWidth;
	const source_height = video.videoHeight;
	const max_side = 1600;
	const scale = Math.min(1, max_side / Math.max(source_width, source_height));
	const width = Math.max(1, Math.round(source_width * scale));
	const height = Math.max(1, Math.round(source_height * scale));
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.save();
	if (options.mirror) {
		ctx.translate(width, 0);
		ctx.scale(-1, 1);
	}
	ctx.drawImage(video, 0, 0, width, height);
	ctx.restore();
	draw_photo_watermark(ctx, width, height, options.watermark || []);
}

function draw_photo_watermark(ctx, width, height, lines) {
	const text_lines = (lines || []).filter(Boolean);
	if (!text_lines.length) return;
	const padding = Math.max(14, Math.round(Math.min(width, height) * 0.024));
	const font_size = Math.max(20, Math.round(Math.min(width, height) * 0.032));
	const line_height = Math.round(font_size * 1.38);
	ctx.save();
	ctx.font = `650 ${font_size}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
	ctx.textBaseline = "top";
	const box_width = Math.min(
		width - padding * 2,
		Math.ceil(Math.max(...text_lines.map((line) => ctx.measureText(line).width)) + padding * 2)
	);
	const box_height = line_height * text_lines.length + padding * 1.4;
	const x = width - box_width - padding;
	const y = height - box_height - padding;
	ctx.globalAlpha = 0.58;
	ctx.fillStyle = "#000";
	ctx.fillRect(x, y, box_width, box_height);
	ctx.globalAlpha = 0.96;
	ctx.fillStyle = "#fff";
	text_lines.forEach((line, index) => {
		ctx.fillText(line, x + padding, y + padding * 0.7 + index * line_height, box_width - padding * 2);
	});
	ctx.restore();
}

function draw_photo_annotation(ctx, shape, width, height) {
	if (!shape?.start || !shape?.end) return;
	const x1 = shape.start.x * width;
	const y1 = shape.start.y * height;
	const x2 = shape.end.x * width;
	const y2 = shape.end.y * height;
	const left = Math.min(x1, x2);
	const top = Math.min(y1, y2);
	const w = Math.abs(x2 - x1);
	const h = Math.abs(y2 - y1);
	if (w < 4 || h < 4) return;
	ctx.save();
	ctx.strokeStyle = "#ff2d2d";
	ctx.lineWidth = Math.max(8, Math.round(Math.min(width, height) * 0.008));
	ctx.lineJoin = "round";
	ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
	ctx.shadowBlur = ctx.lineWidth;
	if (shape.tool === "circle") {
		ctx.beginPath();
		ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
		ctx.stroke();
	} else {
		ctx.strokeRect(left, top, w, h);
	}
	ctx.restore();
}

function draw_annotation_overlay(canvas, shape) {
	if (!canvas) return;
	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.round(rect.width * dpr));
	canvas.height = Math.max(1, Math.round(rect.height * dpr));
	const ctx = canvas.getContext("2d");
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, rect.width, rect.height);
	draw_photo_annotation(ctx, shape, rect.width, rect.height);
}

function clear_annotation_overlay(canvas) {
	if (!canvas) return;
	const ctx = canvas.getContext("2d");
	ctx?.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
}

function quality_process_label(node) {
	const labels = {
		"First Article": "首件",
		Patrol: "制程",
		"Last Article": "末件",
		"Final Release": "入库放行",
		OQC: "出货检查",
	};
	return labels[node] || __(node || "");
}

function current_user_label() {
	return frappe.session?.user_fullname || frappe.user?.full_name?.() || frappe.session?.user || "";
}

function format_local_datetime(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function format_display_datetime(value) {
	if (!value) return "-";
	return frappe.datetime?.str_to_user ? frappe.datetime.str_to_user(value) : String(value);
}

function format_filename_datetime(date) {
	return format_local_datetime(date).replace(/[-: ]/g, "");
}

function status_tone(status) {
	if (status === "Rejected") return "danger";
	if (status === "Accepted" || status === "Concession Released") return "ok";
	return "";
}

function release_tone(status) {
	if (status === "Released") return "ok";
	if (status === "Temporary Released") return "warn";
	if (status === "Blocked") return "danger";
	return "";
}

function inspection_status_label(status) {
	if (status === "Rejected") return "NG";
	if (status === "Accepted" || status === "Concession Released") return "OK";
	return __("Pending");
}

function oqc_release_status_label(status) {
	const labels = {
		Pending: __("Pending"),
		Released: __("Released"),
		"Temporary Released": __("OQC Temporary Released"),
		Blocked: __("OQC Blocked"),
	};
	return labels[status] || __(status || "");
}

function can_read_doctype(doctype) {
	try {
		return frappe.model.can_read(doctype);
	} catch (error) {
		console.error(error);
		return false;
	}
}

function get_shift_options() {
	try {
		const df = frappe.meta?.get_docfield?.("Work Order Scheduling", "shift_type");
		return df?.options || "\n白班\n晚班";
	} catch (error) {
		console.error(error);
		return "\n白班\n晚班";
	}
}

function clean_route_options(options) {
	const cleaned = {};
	Object.keys(options || {}).forEach((key) => {
		let value = options[key];
		if (typeof value === "string" && (value.startsWith('"') || value.startsWith("["))) {
			try {
				value = JSON.parse(value);
			} catch (e) {
				// keep raw value
			}
		}
		cleaned[key] = value;
	});
	return cleaned;
}

function stable_key_hash(value) {
	let hash = 0;
	const text = String(value || "");
	for (let idx = 0; idx < text.length; idx++) {
		hash = ((hash << 5) - hash + text.charCodeAt(idx)) | 0;
	}
	return Math.abs(hash).toString(36);
}
