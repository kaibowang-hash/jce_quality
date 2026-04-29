from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, get_datetime, now_datetime, today

from jce_quality.services.quality import (
	get_patrol_task_info,
	get_scheduling_item_quality_summary,
	load_template_readings,
	populate_check_from_scheduling,
)


def scan_patrol_reminders():
	now = now_datetime()
	schedules = frappe.get_all(
		"Work Order Scheduling",
		filters={"posting_date": ("between", [add_days(today(), -1), today()])},
		fields=["name", "posting_date", "company", "plant_floor", "shift_type", "status"],
		order_by="posting_date asc, modified asc",
		limit_page_length=200,
	)
	processed = 0
	for schedule in schedules:
		rows = frappe.get_all(
			"Scheduling Item",
			filters={"parent": schedule.name},
			fields=["name", "idx", "item_code", "item_name", "work_order", "workstation", "from_time", "to_time"],
			order_by="idx asc",
		)
		for row in rows:
			summary = get_scheduling_item_quality_summary(row.name)
			patrol_info = get_patrol_task_info(schedule, row, summary)
			if not (patrol_info.get("patrol_due") and patrol_info.get("next_patrol_due_at")):
				continue
			if summary.get("frozen") or summary.get("final_release_status") in ("Accepted", "Concession Released"):
				continue

			check_name = ensure_patrol_check(schedule, row)
			rule = get_applicable_reminder_rule(schedule, row)
			recipients = get_reminder_recipients(rule)
			if not recipients:
				continue
			state = get_or_create_reminder_state(schedule, row, patrol_info, recipients, check_name)
			repeat_interval = cint(rule.repeat_interval_mins) if rule else 30
			if repeat_interval <= 0:
				repeat_interval = 30
			if should_send_reminder(state, repeat_interval, now):
				send_reminders(state, schedule, row, check_name, recipients)
				processed += 1
	return processed


def ensure_patrol_check(schedule, row):
	existing = frappe.db.get_value(
		"Production Quality Check",
		{
			"work_order_scheduling": schedule.name,
			"scheduling_item": row.name,
			"quality_node": "Patrol",
			"docstatus": 0,
		},
		"name",
		order_by="modified desc",
	)
	if existing:
		return existing

	check = frappe.new_doc("Production Quality Check")
	check.quality_node = "Patrol"
	check.work_order_scheduling = schedule.name
	check.scheduling_item = row.name
	populate_check_from_scheduling(check)
	load_template_readings(check)
	check.insert(ignore_permissions=True)
	return check.name


def get_applicable_reminder_rule(schedule, row):
	rules = frappe.get_all(
		"Production Quality Reminder Rule",
		filters={"disabled": 0, "quality_node": "Patrol"},
		fields=[
			"name",
			"company",
			"plant_floor",
			"workstation",
			"shift_type",
			"reminder_users",
			"reminder_role",
			"repeat_interval_mins",
		],
	)

	def matches(rule, fieldname, value):
		rule_value = rule.get(fieldname)
		return not rule_value or (value and rule_value == value)

	def score(rule):
		if not all(
			(
				matches(rule, "company", schedule.company),
				matches(rule, "plant_floor", schedule.plant_floor),
				matches(rule, "workstation", row.workstation),
				matches(rule, "shift_type", schedule.shift_type),
			)
		):
			return -1
		return (
			(20 if rule.workstation else 0)
			+ (15 if rule.plant_floor else 0)
			+ (10 if rule.shift_type else 0)
			+ (5 if rule.company else 0)
		)

	best_rule = None
	best_score = -1
	for rule in rules:
		rule_score = score(rule)
		if rule_score > best_score:
			best_rule = rule
			best_score = rule_score
	return frappe._dict(best_rule) if best_rule and best_score >= 0 else None


def get_reminder_recipients(rule=None):
	recipients = set()
	if rule and rule.get("reminder_users"):
		for token in re.split(r"[\n,;]+", rule.reminder_users):
			user = resolve_user(token.strip())
			if user:
				recipients.add(user)

	role = rule.reminder_role if rule and rule.get("reminder_role") else "Quality Manager"
	recipients.update(get_users_with_role(role))
	if not recipients and role != "Quality Manager":
		recipients.update(get_users_with_role("Quality Manager"))
	return sorted(recipients)


def resolve_user(value):
	if not value:
		return None
	if frappe.db.exists("User", value) and frappe.db.get_value("User", value, "enabled"):
		return value
	user = frappe.db.get_value("User", {"email": value, "enabled": 1}, "name")
	return user


def get_users_with_role(role):
	if not role:
		return []
	users = frappe.get_all(
		"Has Role",
		filters={"role": role, "parenttype": "User"},
		pluck="parent",
		limit_page_length=500,
	)
	if not users:
		return []
	enabled = frappe.get_all("User", filters={"name": ("in", users), "enabled": 1}, pluck="name", limit_page_length=500)
	return enabled


def get_or_create_reminder_state(schedule, row, patrol_info, recipients, check_name):
	due_at = get_datetime(patrol_info.get("next_patrol_due_at"))
	state_name = frappe.db.get_value(
		"Production Quality Reminder State",
		{
			"work_order_scheduling": schedule.name,
			"scheduling_item": row.name,
			"quality_node": "Patrol",
			"due_at": due_at,
			"status": "Open",
		},
		"name",
	)
	if state_name:
		state = frappe.get_doc("Production Quality Reminder State", state_name)
		if state.latest_quality_check != check_name:
			state.db_set("latest_quality_check", check_name, update_modified=False)
		return state

	state = frappe.new_doc("Production Quality Reminder State")
	state.status = "Open"
	state.quality_node = "Patrol"
	state.due_at = due_at
	state.work_order_scheduling = schedule.name
	state.scheduling_item = row.name
	state.latest_quality_check = check_name
	state.item_code = row.item_code
	state.company = schedule.company
	state.plant_floor = schedule.plant_floor
	state.workstation = row.workstation
	state.shift_type = schedule.shift_type
	state.reminder_users = ", ".join(recipients)
	state.insert(ignore_permissions=True)
	return state


def should_send_reminder(state, repeat_interval, now):
	if not state.last_reminded_at:
		return True
	next_send_at = add_to_date(get_datetime(state.last_reminded_at), minutes=repeat_interval)
	return get_datetime(next_send_at) <= now


def send_reminders(state, schedule, row, check_name, recipients):
	subject = _("Patrol inspection due for {0} at {1}").format(row.item_code or "-", row.workstation or "-")
	description = _(
		"Patrol inspection is due for Work Order Scheduling {0}, row {1}, item {2}."
	).format(schedule.name, row.idx, row.item_code or "-")
	for user in recipients:
		ensure_todo(user, check_name, description)
		create_notification(user, check_name, subject, description)

	state.db_set("last_reminded_at", now_datetime(), update_modified=False)
	state.db_set("reminder_count", cint(state.reminder_count) + 1, update_modified=True)


def ensure_todo(user, check_name, description):
	if frappe.db.exists(
		"ToDo",
		{
			"allocated_to": user,
			"reference_type": "Production Quality Check",
			"reference_name": check_name,
			"status": "Open",
		},
	):
		return
	frappe.get_doc(
		{
			"doctype": "ToDo",
			"allocated_to": user,
			"reference_type": "Production Quality Check",
			"reference_name": check_name,
			"description": description,
			"priority": "High",
			"status": "Open",
			"date": today(),
			"assigned_by": frappe.session.user if frappe.session.user != "Guest" else "Administrator",
		}
	).insert(ignore_permissions=True)


def create_notification(user, check_name, subject, description):
	frappe.get_doc(
		{
			"doctype": "Notification Log",
			"subject": subject,
			"for_user": user,
			"type": "Alert",
			"email_content": description,
			"document_type": "Production Quality Check",
			"document_name": check_name,
			"from_user": frappe.session.user if frappe.session.user != "Guest" else "Administrator",
		}
	).insert(ignore_permissions=True)


def close_reminders_for_check(check):
	states = frappe.get_all(
		"Production Quality Reminder State",
		filters={"scheduling_item": check.scheduling_item, "quality_node": "Patrol", "status": "Open"},
		fields=["name", "latest_quality_check"],
	)
	for state in states:
		frappe.db.set_value(
			"Production Quality Reminder State",
			state.name,
			{"status": "Closed", "closed_by": frappe.session.user, "closed_at": now_datetime()},
			update_modified=True,
		)
		for check_name in filter(None, {state.latest_quality_check, check.name}):
			close_open_todos(check_name)


def close_open_todos(check_name):
	todos = frappe.get_all(
		"ToDo",
		filters={
			"reference_type": "Production Quality Check",
			"reference_name": check_name,
			"status": "Open",
		},
		pluck="name",
	)
	for todo in todos:
		frappe.db.set_value("ToDo", todo, "status", "Closed", update_modified=True)
