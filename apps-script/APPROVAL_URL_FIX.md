# Attachment URL comparison fix — 18 November 2026

The approval handler compared the full serialized expense snapshot. Lark attachment download URLs include a `bitablePerm.rev` parameter; it changed while the file tokens and all bill content stayed the same. This produced the false message `รายการมีการแก้ไข ต้องสร้างฉบับแก้ไขก่อนอนุมัติ`.

The live ExpenseRequest project was updated in place as deployment version 55 at 23:27 Asia/Bangkok. Its existing endpoint and access settings were retained.

In `mcApprove_`, replace the raw `JSON.stringify(current)` versus `JSON.stringify(job.items)` hash comparison with:

```javascript
mcAssertApprovalItems_(job.items, current);
```

Include `ApprovalAttachmentIdentity.gs`. The helper removes only an attachment's `url` when a nonempty stable `file_token` exists. It preserves all other fields, attachment identities, names, types and ordering. URL-only attachments still compare their URLs. The existing NOT review, May approval, company, employee, source ownership and document checks stay in place.

When the approved PDF is successfully written, the live handler also writes:

```javascript
fields['สถานะระบบแยกบริษัท'] = 'อนุมัติแล้ว • ' + job.currency;
```

This clears the old error only after successful PDF creation. The immutable original snapshots are not rewritten to match current data.

Validation: 18 regression tests passed, plus comparison of the 14 current summaries covering 28 source bills. Every snapshot difference was an attachment download URL; financial details and stable file tokens matched. Recovery uses existing human approval flags and leaves pending/returned records unapproved.

Run tests with `node --test test/approval-attachment-identity.test.cjs`.
