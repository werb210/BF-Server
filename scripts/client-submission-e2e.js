#!/usr/bin/env node
/* eslint-disable no-console */
const http = require("http");
const https = require("https");
const { URL } = require("url");

const BASE_URL = process.env.SERVER_BASE_URL ?? "https://server.boreal.financial";

const ADMIN_PHONE = process.env.ADMIN_PHONE;
const ADMIN_OTP_CODE = process.env.ADMIN_OTP_CODE || process.env.OTP_CODE;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildRequestOptions(url, method, token, body) {
  const headers = {
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return {
    url,
    options: {
      method,
      headers,
    },
    payload,
  };
}

async function httpRequest({ method, path, token, body }) {
  const url = new URL(path, BASE_URL);
  const client = url.protocol === "https:" ? https : http;
  const { options, payload } = buildRequestOptions(url, method, token, body);

  return new Promise((resolve, reject) => {
    const req = client.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const contentType = res.headers["content-type"] || "";
        const isJson = contentType.includes("application/json");
        const parsed = isJson && data ? safeJsonParse(data) : null;
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: data,
          json: parsed,
        });
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function safeJsonParse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function assert(condition, message, response) {
  if (!condition) {
    const details = response ? ` (status=${response.status})` : "";
    throw new Error(`${message}${details}`);
  }
}

function assertNoServerError(response, label) {
  assert(response.status !== 500, `${label} returned 500`, response);
  if (typeof response.body === "string" && response.body.includes("\n    at ")) {
    throw new Error(`${label} leaked stack trace`);
  }
}

function logPass(label) {
  console.log(`PASS ${label}`);
}

async function otpLoginFlow() {
  const phone = requireEnv("ADMIN_PHONE", ADMIN_PHONE);
  const code = requireEnv("ADMIN_OTP_CODE", ADMIN_OTP_CODE);

  const start = await httpRequest({
    method: "POST",
    path: "/api/auth/otp/start",
    body: { phone },
  });
  assertNoServerError(start, "admin otp start");
  assert(start.status === 200, "admin otp start expected 200", start);
  logPass("Admin POST /api/auth/otp/start");

  const verify = await httpRequest({
    method: "POST",
    path: "/api/auth/otp/verify",
    body: { phone, code },
  });
  assertNoServerError(verify, "admin otp verify");
  assert(verify.status === 200, "admin otp verify expected 200", verify);
  assert(verify.json?.accessToken, "admin accessToken missing", verify);
  logPass("Admin POST /api/auth/otp/verify");

  return verify.json.accessToken;
}

function buildDocumentPayload(documentType, title, size = 2048) {
  return {
    title,
    documentType,
    metadata: {
      fileName: `${documentType}.pdf`,
      mimeType: "application/pdf",
      size,
    },
    content: "base64data",
  };
}

async function main() {
  const adminToken = await otpLoginFlow();

  const lenders = await httpRequest({
    method: "GET",
    path: "/api/lenders",
    token: adminToken,
  });
  assertNoServerError(lenders, "GET /api/lenders");
  assert(lenders.status === 200, "GET /api/lenders expected 200", lenders);
  assert(Array.isArray(lenders.json), "GET /api/lenders expected array", lenders);
  logPass("GET /api/lenders");

  let lender = lenders.json[0];
  if (!lender) {
    const lenderCreate = await httpRequest({
      method: "POST",
      path: "/api/lenders",
      token: adminToken,
      body: {
        name: `E2E Lender ${Date.now()}`,
        country: "US",
        submissionMethod: "api",
      },
    });
    assertNoServerError(lenderCreate, "POST /api/lenders");
    assert(lenderCreate.status === 201, "POST /api/lenders expected 201", lenderCreate);
    lender = lenderCreate.json;
    logPass("POST /api/lenders");
  }

  const lenderProducts = await httpRequest({
    method: "GET",
    path: "/api/lender-products",
    token: adminToken,
  });
  assertNoServerError(lenderProducts, "GET /api/lender-products");
  assert(
    lenderProducts.status === 200,
    "GET /api/lender-products expected 200",
    lenderProducts
  );
  assert(Array.isArray(lenderProducts.json), "GET /api/lender-products expected array", lenderProducts);
  logPass("GET /api/lender-products");

  const productCreate = await httpRequest({
    method: "POST",
    path: "/api/lender-products",
    token: adminToken,
    body: {
      lenderId: lender.id,
      name: `E2E Product ${Date.now()}`,
      type: "standard",
      active: true,
      status: "active",
      required_documents: [],
    },
  });
  assertNoServerError(productCreate, "POST /api/lender-products");
  assert(productCreate.status === 201, "POST /api/lender-products expected 201", productCreate);
  logPass("POST /api/lender-products");
  const lenderProduct = productCreate.json;

  const requirementDefs = [
    { document_type: "bank_statement", required: true },
    { document_type: "id_document", required: true },
    { document_type: "void_cheque", required: false },
  ];

  const requirementResponses = [];
  for (const requirement of requirementDefs) {
    const res = await httpRequest({
      method: "POST",
      path: `/api/lender-products/${lenderProduct.id}/requirements`,
      token: adminToken,
      body: requirement,
    });
    assertNoServerError(res, "POST /api/lender-products/:id/requirements");
    assert(
      res.status === 201,
      "POST /api/lender-products/:id/requirements expected 201",
      res
    );
    requirementResponses.push(res.json.requirement);
  }
  logPass("POST /api/lender-products/:id/requirements");

  const clientProducts = await httpRequest({
    method: "GET",
    path: "/api/client/lender-products",
  });
  assertNoServerError(clientProducts, "GET /api/client/lender-products");
  assert(
    clientProducts.status === 200,
    "GET /api/client/lender-products expected 200",
    clientProducts
  );
  assert(Array.isArray(clientProducts.json), "client lender products should be array", clientProducts);
  logPass("GET /api/client/lender-products");

  const clientProduct = clientProducts.json.find((item) => item.id === lenderProduct.id);
  assert(clientProduct, "expected created lender product to be listed for client", clientProducts);

  const clientRequirements = await httpRequest({
    method: "GET",
    path: `/api/client/lender-products/${lenderProduct.id}/requirements`,
  });
  assertNoServerError(clientRequirements, "GET /api/client/lender-products/:id/requirements");
  assert(
    clientRequirements.status === 200,
    "GET /api/client/lender-products/:id/requirements expected 200",
    clientRequirements
  );
  const requirements = clientRequirements.json?.requirements || [];
  assert(Array.isArray(requirements), "client requirements expected array", clientRequirements);
  assert(
    requirements.filter((req) => req.required).length >= 2,
    "expected at least 2 required requirements",
    clientRequirements
  );
  assert(
    requirements.filter((req) => !req.required).length >= 1,
    "expected at least 1 optional requirement",
    clientRequirements
  );
  logPass("GET /api/client/lender-products/:id/requirements");

  const submissionKey = `client-submission-${Date.now()}`;
  const documents = requirements.map((req) =>
    buildDocumentPayload(req.documentType, `Doc ${req.documentType}`)
  );

  const invalidSubmission = await httpRequest({
    method: "POST",
    path: "/api/client/submissions",
    body: {
      submissionKey: `${submissionKey}-invalid`,
      productType: clientProduct.type,
      selected_lender_product_id: lenderProduct.id,
      business: {
        legalName: "Invalid Docs LLC",
        taxId: "12-3456789",
        entityType: "llc",
        address: {
          line1: "100 Market St",
          city: "San Francisco",
          state: "CA",
          postalCode: "94105",
          country: "US",
        },
      },
      applicant: {
        firstName: "Ivy",
        lastName: "Invalid",
        email: "invalid@applicant.test",
        phone: "+1-555-555-0102",
      },
      documents: [
        ...documents,
        buildDocumentPayload("extra_doc", "Extra Doc"),
      ],
    },
  });
  assertNoServerError(invalidSubmission, "POST /api/client/submissions invalid docs");
  assert(
    invalidSubmission.status === 400,
    "expected invalid submission to return 400",
    invalidSubmission
  );
  logPass("POST /api/client/submissions rejects extra docs");

  const submission = await httpRequest({
    method: "POST",
    path: "/api/client/submissions",
    body: {
      submissionKey,
      productType: clientProduct.type,
      selected_lender_product_id: lenderProduct.id,
      business: {
        legalName: "Acme Holdings LLC",
        taxId: "12-3456789",
        entityType: "llc",
        address: {
          line1: "100 Market St",
          city: "San Francisco",
          state: "CA",
          postalCode: "94105",
          country: "US",
        },
      },
      applicant: {
        firstName: "Ava",
        lastName: "Applicant",
        email: "ava@applicant.test",
        phone: "+1-555-555-0101",
      },
      documents,
    },
  });
  assertNoServerError(submission, "POST /api/client/submissions");
  assert(submission.status === 201, "POST /api/client/submissions expected 201", submission);
  const applicationId = submission.json?.submission?.applicationId;
  assert(applicationId, "submission response missing applicationId", submission);
  logPass("POST /api/client/submissions");

  const application = await httpRequest({
    method: "GET",
    path: `/api/applications/${applicationId}`,
    token: adminToken,
  });
  assertNoServerError(application, "GET /api/applications/:id");
  assert(application.status === 200, "GET /api/applications/:id expected 200", application);
  assert(application.json?.application, "application response missing application", application);
  const appRecord = application.json.application;
  assert(
    ["DOCUMENTS_REQUIRED", "IN_REVIEW"].includes(appRecord.pipelineState),
    "unexpected pipeline state",
    application
  );
  assert(
    appRecord.lenderProductId === lenderProduct.id,
    "lenderProductId mismatch",
    application
  );
  assert(
    Array.isArray(appRecord.metadata?.requirementsSnapshot),
    "requirements snapshot missing",
    application
  );
  const requirementsSnapshot = appRecord.metadata.requirementsSnapshot;
  logPass("GET /api/applications/:id");

  const docList = await httpRequest({
    method: "GET",
    path: `/api/applications/${applicationId}/documents`,
    token: adminToken,
  });
  assertNoServerError(docList, "GET /api/applications/:id/documents");
  assert(docList.status === 200, "GET /api/applications/:id/documents expected 200", docList);
  const docs = docList.json?.documents || [];
  assert(Array.isArray(docs), "documents response missing array", docList);
  const documentTypes = docs.map((doc) => doc.documentType).sort();
  const requirementTypes = requirements.map((req) => req.documentType).sort();
  assert(
    requirementTypes.every((type) => documentTypes.includes(type)),
    "required/optional docs missing",
    docList
  );
  assert(
    documentTypes.every((type) => requirementTypes.includes(type)),
    "extra docs accepted",
    docList
  );
  assert(
    docs.every((doc) => doc.status === "uploaded"),
    "document status not uploaded",
    docList
  );
  logPass("GET /api/applications/:id/documents");

  const portalList = await httpRequest({
    method: "GET",
    path: "/api/portal/applications",
  });
  assertNoServerError(portalList, "GET /api/portal/applications");
  assert(
    portalList.status === 200,
    "GET /api/portal/applications expected 200",
    portalList
  );
  const portalItems = portalList.json?.items || [];
  assert(
    portalItems.some((item) => item.id === applicationId),
    "application missing from portal pipeline list",
    portalList
  );
  logPass("GET /api/portal/applications");

  const portalApp = await httpRequest({
    method: "GET",
    path: `/api/portal/applications/${applicationId}`,
  });
  assertNoServerError(portalApp, "GET /api/portal/applications/:id");
  assert(
    portalApp.status === 200,
    "GET /api/portal/applications/:id expected 200",
    portalApp
  );
  assert(
    portalApp.json?.application?.id === applicationId,
    "portal application mismatch",
    portalApp
  );
  assert(
    portalApp.json?.pipeline?.state === appRecord.pipelineState,
    "portal pipeline state mismatch",
    portalApp
  );
  logPass("GET /api/portal/applications/:id");

  const requiredDoc = docs.find((doc) =>
    requirements.find((req) => req.required && req.documentType === doc.documentType)
  );
  assert(requiredDoc, "unable to locate required document to remove", docList);

  const removeDoc = await httpRequest({
    method: "DELETE",
    path: `/api/applications/${applicationId}/documents/${requiredDoc.documentId}`,
    token: adminToken,
  });
  assertNoServerError(removeDoc, "DELETE /api/applications/:id/documents/:documentId");
  assert(
    removeDoc.status === 200,
    "DELETE /api/applications/:id/documents/:documentId expected 200",
    removeDoc
  );
  logPass("DELETE /api/applications/:id/documents/:documentId");

  const afterRemove = await httpRequest({
    method: "GET",
    path: `/api/applications/${applicationId}`,
    token: adminToken,
  });
  assertNoServerError(afterRemove, "GET /api/applications/:id after delete");
  assert(
    afterRemove.json?.application?.pipelineState === "DOCUMENTS_REQUIRED",
    "pipeline state did not move to DOCUMENTS_REQUIRED after delete",
    afterRemove
  );
  logPass("Pipeline moved to DOCUMENTS_REQUIRED after delete");

  const reupload = await httpRequest({
    method: "POST",
    path: `/api/applications/${applicationId}/documents`,
    token: adminToken,
    body: buildDocumentPayload(requiredDoc.documentType, `Reupload ${requiredDoc.documentType}`),
  });
  assertNoServerError(reupload, "POST /api/applications/:id/documents");
  assert(reupload.status === 201, "POST /api/applications/:id/documents expected 201", reupload);
  logPass("POST /api/applications/:id/documents");

  const accept = await httpRequest({
    method: "POST",
    path: `/api/applications/${applicationId}/documents/${reupload.json.document.documentId}/versions/${reupload.json.document.versionId}/accept`,
    token: adminToken,
  });
  assertNoServerError(accept, "POST /api/applications/:id/documents/:docId/versions/:versionId/accept");
  assert(
    accept.status === 200,
    "POST /api/applications/:id/documents/:docId/versions/:versionId/accept expected 200",
    accept
  );
  logPass("POST /api/applications/:id/documents/:docId/versions/:versionId/accept");

  const afterReupload = await httpRequest({
    method: "GET",
    path: `/api/applications/${applicationId}`,
    token: adminToken,
  });
  assertNoServerError(afterReupload, "GET /api/applications/:id after reupload");
  assert(
    afterReupload.json?.application?.pipelineState === "IN_REVIEW",
    "pipeline state did not move to IN_REVIEW after reupload",
    afterReupload
  );
  logPass("Pipeline moved to IN_REVIEW after reupload");

  const updatedRequirement = requirementResponses.find((req) => req.documentType === "void_cheque");
  assert(updatedRequirement, "missing requirement to update");
  const updateRequirement = await httpRequest({
    method: "PUT",
    path: `/api/lender-products/${lenderProduct.id}/requirements/${updatedRequirement.id}`,
    token: adminToken,
    body: {
      document_type: updatedRequirement.documentType,
      required: true,
      min_amount: updatedRequirement.minAmount,
      max_amount: updatedRequirement.maxAmount,
    },
  });
  assertNoServerError(updateRequirement, "PUT /api/lender-products/:id/requirements/:reqId");
  assert(
    updateRequirement.status === 200,
    "PUT /api/lender-products/:id/requirements/:reqId expected 200",
    updateRequirement
  );
  logPass("PUT /api/lender-products/:id/requirements/:reqId");

  const afterRequirementChange = await httpRequest({
    method: "GET",
    path: `/api/applications/${applicationId}`,
    token: adminToken,
  });
  assertNoServerError(afterRequirementChange, "GET /api/applications/:id after requirement change");
  const updatedSnapshot = afterRequirementChange.json?.application?.metadata?.requirementsSnapshot;
  assert(
    JSON.stringify(updatedSnapshot) === JSON.stringify(requirementsSnapshot),
    "requirements snapshot mutated after requirement change",
    afterRequirementChange
  );
  logPass("Requirements snapshot stable after requirement change");

  console.log("CLIENT → SERVER → LENDER-READY SUBMISSION GREEN");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
