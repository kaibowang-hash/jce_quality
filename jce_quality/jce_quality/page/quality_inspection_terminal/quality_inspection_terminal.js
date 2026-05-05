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
	wrapper.quality_terminal?.refresh();
};

frappe.pages["quality-inspection-terminal"].on_page_hide = function (wrapper) {
	$("body").removeClass("jce-quality-terminal-focus-active jce-quality-terminal-fullscreen-active");
	wrapper.quality_terminal?.body?.removeClass("jce-terminal-fullscreen");
};

const DRAWING_WIDTH_KEY = "jce_quality_terminal_drawing_width";
const PDFJS_SRC = "/assets/jce_quality/vendor/pdfjs/pdf.min.js";
const PDFJS_WORKER = "/assets/jce_quality/vendor/pdfjs/pdf.worker.min.js";

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
		};
		this.drawingWidth = this.get_stored_drawing_width();
		this.drawing_state = {};
		this.defect_options = [];
		this.pdfjs_promise = null;
		this.tasks = [];
		this.refreshRequestId = 0;
		this.refreshTimer = null;
		this.filtersRendered = false;
		this.fullscreenActive = true;
		this.nativeFullscreenRequested = false;
		this.defectControlCounter = 0;
		this.ngActionDialogShown = new Set();
		Object.assign(this.filters, clean_route_options(frappe.route_options || {}));
		frappe.route_options = null;
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh());
		this.body = $(`<div class="jce-q-terminal"></div>`).appendTo(this.page.body);
		this.inject_style();
		this.install_pwa_head();
		this.bind_fullscreen_change();
		this.render_task_list_view();
		this.load_defect_options();
	}

	refresh() {
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
				<section class="jce-q-filter-panel">
					<div class="jce-q-filter-title">${__("Filters")}</div>
					<div class="jce-q-toolbar"></div>
				</section>
				${this.render_pwa_hint()}
				<div class="jce-q-task-list"></div>
			</div>
		`);
		this.update_fullscreen_class(true);
		this.body.find('[data-action="fullscreen"]').on("click", () => this.toggle_fullscreen());
		this.body.find('[data-action="dismiss-pwa-hint"]').on("click", () => this.dismiss_pwa_hint());
		this.render_filters();
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
			const holder = $('<div class="jce-q-filter"></div>').appendTo(toolbar);
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
			.find("button")
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
		const frozen = task.frozen ? `<span class="jce-q-pill danger">${__("NG Frozen")}</span>` : "";
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
		const first_article_status = cint(task.first_article_required) ? task.first_article_status : "Not Required";
		const last_article_status = cint(task.last_article_required) ? task.last_article_status : "Not Required";
		const final_release_status = cint(task.final_release_required) ? task.final_release_status : "Not Required";
		const alert_note = task.quality_alert_note
			? `<div class="jce-q-task-alert">${esc(task.quality_alert_note)}</div>`
			: "";
		const complete_pill = cint(task.quality_complete)
			? `<span class="jce-q-pill ok">${__("Complete")}</span>`
			: `<span class="jce-q-pill">${__("Open")}</span>`;
		const alert_pill = cint(task.quality_alert_open)
			? `<span class="jce-q-pill danger">${__("Alert")}</span>`
			: "";

		return `
			<div class="jce-q-task">
				<div class="jce-q-task-card-head">
					<span class="jce-q-station">${esc(task.workstation || "-")}</span>
					<div class="jce-q-task-badges">${complete_pill}${alert_pill}${frozen}</div>
				</div>
				<div class="jce-q-task-title">
					<div>
						<b>${esc(task.item_code)}</b>
						${customer_code ? `<em>${__("Customer Code")}: ${esc(customer_code)}</em>` : ""}
						<span>${esc(task.item_name || "")}</span>
					</div>
				</div>
				${alert_note}
				<div class="jce-q-task-meta-grid">
					<div><span>${__("Work Order")}</span><b>${esc(task.work_order || "-")}</b></div>
					<div><span>${__("Qty")}</span><b>${esc(format_float(task.scheduling_qty || 0))}</b></div>
					<div><span>${__("Shift")}</span><b>${esc(task.shift_type || "-")}</b></div>
					<div><span>${__("Extra Patrol")}</span><b>${cint(task.extra_patrol_count) || "-"}</b></div>
				</div>
				<div class="jce-q-node-row">
					${this.node_button("First Article", first_article_status)}
					${this.node_button("Patrol", patrol_status)}
					${this.node_button("Last Article", last_article_status)}
					${this.node_button("Final Release", final_release_status)}
				</div>
			</div>
		`;
	}

	node_button(node, status) {
		const tone = status === "Accepted" || status === "Concession Released" ? "ok" : ["Rejected", "Overdue"].includes(status) ? "danger" : status === "Not Required" ? "" : "warn";
		const disabled = status === "Not Required" ? "disabled" : "";
		return `<button class="jce-q-node ${tone}" data-node="${esc(node)}" ${disabled}><span>${esc(__(node))}</span><b>${esc(__(status || "Pending"))}</b></button>`;
	}

	open_check(task, node) {
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

	enter_focus_mode() {
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
			: `${doc.overall_status === "Rejected" && doc.disposition !== "Concession Release" ? `<button class="jce-q-bar-button warn" data-action="concession">${__("Concession")}</button>` : ""}
				${this.fullscreen_toolbar_button()}
				<button class="jce-q-bar-button" data-action="open-form">${__("Open Form")}</button>`;

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
		shell.find('[data-action="concession"]').on("click", () => this.apply_concession());
		shell.find('[data-action="open-form"]').on("click", () => frappe.set_route("Form", "Production Quality Check", this.current.name));
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
		if (this.ngActionDialogShown.has(this.current.name)) return;
		this.ngActionDialogShown.add(this.current.name);
		setTimeout(() => this.open_ng_action_dialog({ automatic: true }), 220);
	}

	open_ng_action_dialog() {
		if (!this.current || this.current.overall_status !== "Rejected") return;
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
			control.$input?.on("change input blur awesomplete-selectcomplete", () => hidden.val(control.get_value() || control.$input.val() || ""));
			holder.data("control", control);
		});
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
		frappe.prompt(
			[{ fieldname: "remarks", fieldtype: "Small Text", label: __("Remarks") }],
			(values) => {
				frappe.call({
					method: "jce_quality.api.quality.set_disposition",
					args: {
						check_name: this.current.name,
						disposition: "Concession Release",
						remarks: values.remarks,
					},
					freeze: true,
					freeze_message: __("Applying concession release..."),
				}).then((r) => {
					this.current = r.message;
					this.render_focus_shell();
					this.refresh();
				});
			},
			__("Apply Concession Release")
		);
	}

	attach_photo() {
		if (!window.isSecureContext) {
			frappe.msgprint({
				title: __("Camera Permission"),
				message: __("Camera access requires HTTPS or a secure local context on Apple devices."),
				indicator: "orange",
			});
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia) {
			this.open_camera_file_fallback();
			return;
		}
		this.open_terminal_sheet({
			title: __("Camera Permission"),
			body: `
				<div class="jce-q-dialog-summary">${esc(__("The browser will ask for camera access. Allow it to take inspection photos with a watermark."))}</div>
			`,
			primary_label: __("Continue"),
			on_primary: async () => {
				this.close_terminal_sheet();
				this.open_camera_capture_dialog();
			},
		});
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
				const caption = this.get_photo_watermark_lines(this.current).join(" / ");
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
		let captured_caption = "";
		let current_device_id = "";
		let device_list = [];
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
					const caption = captured_caption || this.get_photo_watermark_lines(doc).join(" / ");
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
					<div class="jce-q-camera-badge">${esc(this.get_photo_watermark_lines(doc).join(" · "))}</div>
					<button type="button" class="jce-q-camera-shot" data-camera-action="capture" title="${__("Capture Photo")}" aria-label="${__("Capture Photo")}">${icon_html("camera")}</button>
					<button type="button" class="jce-q-camera-retake" data-camera-action="retake" title="${__("Retake")}" aria-label="${__("Retake")}" hidden>${icon_html("rotate-ccw")}</button>
				</div>
				<div class="jce-q-camera-hint">${__("The photo will be saved with an inspection watermark in the lower right corner.")}</div>
			</div>
		`);

		const video = $camera.find(".jce-q-camera-video").get(0);
		const canvas = $camera.find(".jce-q-camera-canvas").get(0);
		const $shot = $camera.find('[data-camera-action="capture"]');
		const $retake = $camera.find('[data-camera-action="retake"]');
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
			if (!enabled) captured_caption = "";
			d.get_primary_btn().prop("disabled", !enabled);
			$(video).prop("hidden", enabled);
			$(canvas).prop("hidden", !enabled);
			$shot.prop("hidden", enabled);
			$retake.prop("hidden", !enabled);
		};

		$shot.on("click", () => {
			if (!video.videoWidth || !video.videoHeight) {
				frappe.msgprint(__("Camera is not ready yet."));
				return;
			}
			const watermark = this.get_photo_watermark_lines(doc);
			captured_caption = watermark.join(" / ");
			render_inspection_photo(video, canvas, {
				mirror: !!d.get_value("mirror"),
				watermark,
			});
			set_captured(true);
		});
		$retake.on("click", () => set_captured(false));
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
					overflow: auto !important;
					-webkit-overflow-scrolling: touch;
				}
				body.jce-quality-terminal-fullscreen-active .modal-dialog {
					margin: max(12px, env(safe-area-inset-top)) auto max(12px, env(safe-area-inset-bottom));
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
				body.jce-quality-terminal-focus-active .modal .modal-header .btn-modal-minimize {
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
				.jce-q-filter-panel {
					margin-bottom: 12px;
					padding: 10px;
					border: 1px solid var(--jce-line-soft);
					border-radius: 8px;
					background: rgba(255, 255, 255, 0.68);
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
				.jce-q-node b {
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
				.jce-q-node.ok { background: #ecf9f0; color: var(--jce-green); }
				.jce-q-node.warn { background: #fff6e5; color: var(--jce-orange); }
				.jce-q-node.danger { background: #fff1f2; color: var(--jce-red); }
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
					gap: 12px;
				}
				.jce-q-camera-stage {
					position: relative;
					width: min(100%, 920px);
					margin: 0 auto;
					aspect-ratio: 4 / 3;
					overflow: hidden;
					border-radius: 8px;
					background: #000;
					border: 1px solid var(--jce-line-soft);
				}
				.jce-q-camera-video,
				.jce-q-camera-canvas {
					width: 100%;
					height: 100%;
					object-fit: contain;
					display: block;
					background: #000;
				}
				.jce-q-camera-video[hidden],
				.jce-q-camera-canvas[hidden],
				.jce-q-camera-shot[hidden],
				.jce-q-camera-retake[hidden] {
					display: none;
				}
				.jce-q-camera-badge {
					position: absolute;
					right: 12px;
					bottom: 12px;
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
					.jce-q-defect-row { grid-template-columns: 1fr; }
					.jce-q-system-result { grid-template-columns: repeat(2, minmax(0, 1fr)); }
					.jce-q-toolbar-actions .jce-q-bar-button { flex: 1 1 calc(50% - 8px); }
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

const JCE_ICONS = {
	"alert-triangle": '<path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	camera: '<path d="M14.5 4 16 6h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l1.5-2h5Z"/><circle cx="12" cy="13" r="3.5"/>',
	"chevron-left": '<path d="m15 18-6-6 6-6"/>',
	"chevron-right": '<path d="m9 18 6-6-6-6"/>',
	"external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	"file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
	list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
	"maximize-2": '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="M9 21H3v-6"/><path d="m3 21 7-7"/>',
	"minimize-2": '<path d="M4 14h6v6"/><path d="m10 14-7 7"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/>',
	"move-horizontal": '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
	plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
	"refresh-cw": '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/>',
	"rotate-ccw": '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/>',
	"trash-2": '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
	x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	"zoom-in": '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
	"zoom-out": '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
};

function icon_html(icon) {
	const paths = JCE_ICONS[icon] || JCE_ICONS["alert-triangle"];
	return `<svg class="jce-q-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
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

function quality_process_label(node) {
	const labels = {
		"First Article": "首件",
		Patrol: "制程",
		"Last Article": "末件",
		"Final Release": "入库放行",
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

function format_filename_datetime(date) {
	return format_local_datetime(date).replace(/[-: ]/g, "");
}

function status_tone(status) {
	if (status === "Rejected") return "danger";
	if (status === "Accepted" || status === "Concession Released") return "ok";
	return "";
}

function inspection_status_label(status) {
	if (status === "Rejected") return "NG";
	if (status === "Accepted" || status === "Concession Released") return "OK";
	return __("Pending");
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
