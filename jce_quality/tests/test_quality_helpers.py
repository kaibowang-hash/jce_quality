import unittest
from unittest.mock import patch

import frappe

from jce_quality.services.quality import (
	DELIVERY_NOTE_OQC_SOURCE_TYPE,
	DELIVERY_PLAN_OQC_SOURCE_TYPE,
	apply_rule_to_check,
	get_required_check_count,
	is_first_article_required_for_row,
	is_oqc_check_ready_for_email,
	summary_meets_requirements,
	validate_oqc_release_request,
)


class TestQualityHelpers(unittest.TestCase):
	def test_required_check_count_respects_optional_rules(self):
		optional_rule = frappe._dict(is_mandatory=0, minimum_patrol_count=3)
		mandatory_rule = frappe._dict(is_mandatory=1, minimum_patrol_count=3)

		self.assertEqual(get_required_check_count(optional_rule, "Patrol"), 0)
		self.assertEqual(get_required_check_count(mandatory_rule, "Patrol"), 3)
		self.assertEqual(get_required_check_count(None, "Patrol"), 0)
		self.assertEqual(get_required_check_count(None, "First Article"), 0)

	def test_first_article_requires_schedule_flag(self):
		rule = frappe._dict(is_mandatory=1)

		self.assertFalse(is_first_article_required_for_row(frappe._dict(custom_is_first_article=0)))
		self.assertTrue(is_first_article_required_for_row(frappe._dict(custom_is_first_article=1)))
		self.assertTrue(is_first_article_required_for_row(frappe._dict(first_article_required=1)))
		self.assertEqual(get_required_check_count(rule, "First Article", frappe._dict(custom_is_first_article=0)), 0)
		self.assertEqual(get_required_check_count(rule, "First Article", frappe._dict(custom_is_first_article=1)), 1)

	def test_summary_meets_requirements_uses_patrol_count(self):
		summary = {
			"frozen": False,
			"patrol_count": 2,
			"first_article_status": "Accepted",
			"last_article_status": "Accepted",
			"final_release_status": "Accepted",
		}

		self.assertTrue(
			summary_meets_requirements(
				summary,
				{"First Article": 1, "Patrol": 2, "Last Article": 1, "Final Release": 1},
			)
		)
		self.assertFalse(
			summary_meets_requirements(
				summary,
				{"First Article": 1, "Patrol": 3, "Last Article": 1, "Final Release": 1},
			)
		)

	def test_oqc_email_ready_requires_submitted_released_passing_check(self):
		self.assertFalse(
			is_oqc_check_ready_for_email(
				frappe._dict(docstatus=0, overall_status="Accepted", release_status="Released")
			)
		)
		self.assertFalse(
			is_oqc_check_ready_for_email(
				frappe._dict(docstatus=1, overall_status="Rejected", release_status="Released")
			)
		)
		self.assertTrue(
			is_oqc_check_ready_for_email(
				frappe._dict(docstatus=1, overall_status="Accepted", release_status="Released")
			)
		)

	def test_oqc_release_validation_requires_submitted_passing_state(self):
		def raise_validation(message, *args, **kwargs):
			raise frappe.ValidationError(message)

		with (
			patch("jce_quality.services.quality._", lambda text, *args, **kwargs: text),
			patch("jce_quality.services.quality.frappe.throw", raise_validation),
		):
			draft = frappe._dict(source_type=DELIVERY_NOTE_OQC_SOURCE_TYPE, docstatus=0, overall_status="Accepted")
			with self.assertRaises(frappe.ValidationError):
				validate_oqc_release_request(draft, "Released")

			rejected = frappe._dict(
				source_type=DELIVERY_NOTE_OQC_SOURCE_TYPE,
				source_name="DN-1",
				docstatus=1,
				overall_status="Rejected",
			)
			with self.assertRaises(frappe.ValidationError):
				with patch("jce_quality.services.quality.get_delivery_note_doc"):
					validate_oqc_release_request(rejected, "Released")
			with patch("jce_quality.services.quality.get_delivery_note_doc"):
				validate_oqc_release_request(rejected, "Blocked", escalate_to_dmr=True)

			accepted = frappe._dict(
				source_type=DELIVERY_NOTE_OQC_SOURCE_TYPE,
				source_name="DN-1",
				docstatus=1,
				overall_status="Accepted",
			)
			with patch("jce_quality.services.quality.get_delivery_note_doc") as get_delivery_note_doc:
				validate_oqc_release_request(accepted, "Released")
				get_delivery_note_doc.assert_called_with("DN-1", require_submitted=True, allow_return=False)
			with self.assertRaises(frappe.ValidationError):
				with patch("jce_quality.services.quality.get_delivery_note_doc"):
					validate_oqc_release_request(accepted, "Temporary Released")
			with patch("jce_quality.services.quality.get_delivery_note_doc"):
				validate_oqc_release_request(accepted, "Temporary Released", temporary_release_note="Customer approval")

	def test_delivery_plan_oqc_final_release_requires_delivery_note(self):
		def raise_validation(message, *args, **kwargs):
			raise frappe.ValidationError(message)

		with (
			patch("jce_quality.services.quality._", lambda text, *args, **kwargs: text),
			patch("jce_quality.services.quality.frappe.throw", raise_validation),
		):
			check = frappe._dict(source_type=DELIVERY_PLAN_OQC_SOURCE_TYPE, docstatus=1, overall_status="Accepted")
			with self.assertRaises(frappe.ValidationError):
				validate_oqc_release_request(check, "Released")

	def test_sample_is_optional_without_matching_rule(self):
		doc = frappe._dict(
			company="JCE",
			plant_floor=None,
			workstation=None,
			item_code=None,
			item_group=None,
			quality_node="OQC",
			production_quality_rule="OLD-RULE",
			quality_inspection_template=None,
			requires_sample=1,
			required_sample_type="Golden",
			sample_manager=None,
		)
		with patch("jce_quality.services.quality.get_applicable_rule", return_value=None):
			apply_rule_to_check(doc)
		self.assertEqual(doc.requires_sample, 0)
		self.assertIsNone(doc.production_quality_rule)
		self.assertIsNone(doc.required_sample_type)
		self.assertIsNone(doc.quality_inspection_template)

	def test_frozen_summary_never_meets_requirements(self):
		self.assertFalse(
			summary_meets_requirements(
				{
					"frozen": True,
					"patrol_count": 10,
					"first_article_status": "Accepted",
					"last_article_status": "Accepted",
					"final_release_status": "Accepted",
				},
				{"First Article": 0, "Patrol": 0, "Last Article": 0, "Final Release": 0},
			)
		)
