/**
 * Assembling one change request's deployment from its parts: children of
 * an object (fields, record types, business processes) go into that
 * object's one `objects/<Object>.object` file, other components into their
 * own files, each with its manifest member, its review-page component and
 * the precondition it was built on.
 */

import { objectFileXml, packageXml, type PackageMember } from '@renkei/connector-salesforce';
import type {
  ComponentView,
  DataStep,
  MetadataPayload,
  Precondition,
} from '@/lib/salesforce-admin/plan';

export class PackageBuilder {
  private readonly children = new Map<string, string[]>();
  private readonly files: Record<string, string> = {};
  private readonly members: PackageMember[] = [];
  readonly components: ComponentView[] = [];
  readonly preconditions: Precondition[] = [];
  readonly dataSteps: DataStep[] = [];

  /** An object's child (as objectChildXml or existingFieldXml writes it). */
  objectChild(object: string, xml: string, member: PackageMember): this {
    this.children.set(object, [...(this.children.get(object) ?? []), xml]);
    this.members.push(member);
    return this;
  }

  /** A component in its own file (`globalValueSets/…`, `profiles/…`). */
  file(path: string, content: string, member: PackageMember): this {
    this.files[path] = content;
    this.members.push(member);
    return this;
  }

  /** Whether anything deploys. */
  get deploys(): boolean {
    return this.members.length > 0;
  }

  build(): MetadataPayload {
    const files: Record<string, string> = { ...this.files };
    for (const [object, xml] of this.children)
      files[`objects/${object}.object`] = objectFileXml(xml);
    if (this.members.length > 0) files['package.xml'] = packageXml(this.members);
    return {
      files,
      members: [...this.members],
      components: this.components,
      preconditions: this.preconditions,
      dataSteps: this.dataSteps,
    };
  }
}
