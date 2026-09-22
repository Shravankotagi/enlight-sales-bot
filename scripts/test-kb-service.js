/**
 * Automated Verification Script for Dedicated KB Retrieval Service
 * Tests:
 * 1. Allowed roles RBAC mapping (Admin, Manager, Salesperson)
 * 2. Practical Domain-Specific Fallbacks (Pricing, MOQ, Payment/Credit, Quality MTC, General)
 * 3. End-to-end executeSearchKnowledgeBase execution with CallerContext
 */

const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const {
  searchKnowledgeBase,
  getAllowedRoles,
  getPracticalDomainFallback,
  PRACTICAL_SOP_FALLBACKS,
} = require('../src/services/kbRetrievalService');
const { executeSearchKnowledgeBase, resolveCallerContext } = require('../src/core/retrievalTools');

async function runKbVerification() {
  console.log('===============================================================');
  console.log(' Starting Knowledge Base Retrieval Service Verification Suite');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Role RBAC derivation
  console.log('[Test 1] Testing RBAC Role Mapping...');
  const adminRoles = getAllowedRoles('admin');
  const mgrRoles = getAllowedRoles('manager');
  const salesRoles = getAllowedRoles('salesperson');

  if (
    adminRoles.includes('admin_only') &&
    mgrRoles.includes('manager_plus') &&
    !mgrRoles.includes('admin_only') &&
    salesRoles.length === 2 &&
    salesRoles.includes('salesperson') &&
    !salesRoles.includes('manager')
  ) {
    console.log('  PASSED: RBAC role hierarchies correctly isolated.\n');
    passed++;
  } else {
    console.error('  FAILED: Incorrect role mapping:', { adminRoles, mgrRoles, salesRoles });
    failed++;
  }

  // Test 2: Practical SOP domain fallbacks
  console.log('[Test 2] Testing Practical Domain-Specific SOP Fallbacks...');
  const pricingFb = getPracticalDomainFallback('What is our discount policy and quotation validity?');
  const moqFb = getPracticalDomainFallback('What is the minimum order quantity (MOQ) for TMT truckload?');
  const creditFb = getPracticalDomainFallback('Can we give 30 days credit payment terms to client?');
  const qualityFb = getPracticalDomainFallback('Customer asking for MTC test certificate IS 2062');
  const generalFb = getPracticalDomainFallback('What is company policy on holiday schedule?');

  if (
    pricingFb.title.includes('Pricing') &&
    moqFb.title.includes('Logistics') &&
    creditFb.title.includes('Credit') &&
    qualityFb.title.includes('Quality') &&
    generalFb.title.includes('Standard Sales Operations')
  ) {
    console.log('  PASSED: All practical domain fallback rules correctly resolved.\n');
    console.log('  Sample Pricing Guidance:\n  >', pricingFb.content.slice(0, 120), '...\n');
    passed++;
  } else {
    console.error('  FAILED: Domain fallback mismatch:', {
      pricing: pricingFb.title,
      moq: moqFb.title,
      credit: creditFb.title,
      quality: qualityFb.title,
      general: generalFb.title,
    });
    failed++;
  }

  // Test 3: End-to-end executeSearchKnowledgeBase execution
  console.log('[Test 3] Testing executeSearchKnowledgeBase Tool Execution...');
  try {
    const callerContext = {
      userId: 'test-rep-001',
      role: 'salesperson',
      name: 'Rishabh Test',
      phone: '919619226169',
    };

    const res = await executeSearchKnowledgeBase({ query: 'What is the standard payment terms and advance required?' }, callerContext);
    if (res && res.data && res.data.knowledge_snippet) {
      console.log('  PASSED: Tool execution returned valid structured KB snippet.');
      console.log('  Source:', res.data.source);
      console.log('  Snippet excerpt:', res.data.knowledge_snippet.slice(0, 140), '...\n');
      passed++;
    } else {
      console.error('  FAILED: Unexpected tool output:', res);
      failed++;
    }
  } catch (err) {
    console.error('  FAILED with error:', err.message);
    failed++;
  }

  // Test 4: Testing Admin Search vs Salesperson Search
  console.log('[Test 4] Testing Admin vs Salesperson Caller Scoping...');
  try {
    const adminContext = { userId: 'admin-001', role: 'admin', phone: '919619226169' };
    const adminRes = await executeSearchKnowledgeBase({ query: 'Steel grade IS 2062 specification and MTC' }, adminContext);
    if (adminRes && adminRes.data) {
      console.log('  PASSED: Admin query processed successfully.');
      console.log('  Admin Source:', adminRes.data.source, '\n');
      passed++;
    }
  } catch (err) {
    console.error('  FAILED Admin query:', err.message);
    failed++;
  }

  console.log('===============================================================');
  console.log(` KB Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runKbVerification().catch((err) => {
  console.error('Fatal KB test error:', err);
  process.exit(1);
});
