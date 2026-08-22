#include "partition-description.h"

namespace {

CFStringRef ExpectedPartition() {
  return CFSTR("teamid:FA494ACVTF");
}

CFIndex OccurrenceCount(CFStringRef value, CFStringRef token) {
  CFArrayRef matches = CFStringCreateArrayWithFindResults(
      kCFAllocatorDefault, value, token,
      CFRangeMake(0, CFStringGetLength(value)), 0);
  if (matches == nullptr)
    return 0;
  const CFIndex count = CFArrayGetCount(matches);
  CFRelease(matches);
  return count;
}

bool HasUnambiguousPartitionKey(CFStringRef description) {
  return OccurrenceCount(description, CFSTR("<key")) == 1 &&
         OccurrenceCount(description, CFSTR("<key>Partitions</key>")) == 1 &&
         OccurrenceCount(description, CFSTR("<!ENTITY")) == 0;
}

bool IsAuthorization(CFTypeRef value, CFStringRef expected) {
  return value != nullptr && CFGetTypeID(value) == CFStringGetTypeID() &&
         CFEqual(value, expected);
}

}

bool IsExpectedPartitionDescription(CFStringRef description) {
  if (description == nullptr ||
      CFGetTypeID(description) != CFStringGetTypeID()) {
    return false;
  }
  if (!HasUnambiguousPartitionKey(description))
    return false;
  CFDataRef serialized = CFStringCreateExternalRepresentation(
      kCFAllocatorDefault, description, kCFStringEncodingUTF8, 0);
  if (serialized == nullptr)
    return false;
  CFErrorRef error = nullptr;
  CFPropertyListRef propertyList = CFPropertyListCreateWithData(
      kCFAllocatorDefault, serialized, kCFPropertyListImmutable, nullptr,
      &error);
  CFRelease(serialized);
  if (error != nullptr)
    CFRelease(error);
  if (propertyList == nullptr)
    return false;
  if (CFGetTypeID(propertyList) != CFDictionaryGetTypeID()) {
    CFRelease(propertyList);
    return false;
  }
  CFDictionaryRef dictionary = static_cast<CFDictionaryRef>(propertyList);
  const bool exactKey =
      CFDictionaryGetCount(dictionary) == 1 &&
      CFDictionaryContainsKey(dictionary, CFSTR("Partitions"));
  CFTypeRef partitionsValue =
      CFDictionaryGetValue(dictionary, CFSTR("Partitions"));
  const bool arrayValue =
      exactKey && partitionsValue != nullptr &&
      CFGetTypeID(partitionsValue) == CFArrayGetTypeID();
  bool expected = false;
  if (arrayValue) {
    CFArrayRef partitions = static_cast<CFArrayRef>(partitionsValue);
    if (CFArrayGetCount(partitions) == 1) {
      CFTypeRef partitionValue = CFArrayGetValueAtIndex(partitions, 0);
      expected = partitionValue != nullptr &&
                 CFGetTypeID(partitionValue) == CFStringGetTypeID() &&
                 CFEqual(partitionValue, ExpectedPartition());
    }
  }
  CFRelease(propertyList);
  return expected;
}

bool AreExpectedPartitionDescriptions(CFArrayRef descriptions) {
  if (descriptions == nullptr ||
      CFGetTypeID(descriptions) != CFArrayGetTypeID() ||
      CFArrayGetCount(descriptions) != 1) {
    return false;
  }
  CFTypeRef description = CFArrayGetValueAtIndex(descriptions, 0);
  return description != nullptr &&
         CFGetTypeID(description) == CFStringGetTypeID() &&
         IsExpectedPartitionDescription(static_cast<CFStringRef>(description));
}

bool IsExpectedPartitionAcl(CFArrayRef authorizations, CFArrayRef applications,
                            CFStringRef description,
                            SecKeychainPromptSelector prompt) {
  if (authorizations == nullptr ||
      CFGetTypeID(authorizations) != CFArrayGetTypeID() ||
      CFArrayGetCount(authorizations) != 1) {
    return false;
  }
  CFTypeRef authorization = CFArrayGetValueAtIndex(authorizations, 0);
  return authorization != nullptr &&
         CFGetTypeID(authorization) == CFStringGetTypeID() &&
         CFEqual(authorization, kSecACLAuthorizationPartitionID) &&
         applications == nullptr && prompt == 0 &&
         IsExpectedPartitionDescription(description);
}

KeychainAclRole ClassifyKeychainAcl(CFArrayRef authorizations) {
  if (authorizations == nullptr ||
      CFGetTypeID(authorizations) != CFArrayGetTypeID() ||
      CFArrayGetCount(authorizations) == 0) {
    return KeychainAclRole::kUnsafe;
  }
  bool owner = false;
  bool partition = false;
  const CFIndex count = CFArrayGetCount(authorizations);
  for (CFIndex index = 0; index < count; index += 1) {
    CFTypeRef authorization = CFArrayGetValueAtIndex(authorizations, index);
    if (authorization == nullptr ||
        CFGetTypeID(authorization) != CFStringGetTypeID()) {
      return KeychainAclRole::kUnsafe;
    }
    owner = owner ||
            IsAuthorization(authorization, kSecACLAuthorizationChangeACL);
    partition =
        partition ||
        IsAuthorization(authorization, kSecACLAuthorizationPartitionID);
    if (IsAuthorization(authorization, kSecACLAuthorizationAny) ||
        IsAuthorization(authorization, kSecACLAuthorizationChangeOwner)) {
      return KeychainAclRole::kUnsafe;
    }
  }
  if (owner && partition)
    return KeychainAclRole::kUnsafe;
  if (owner)
    return KeychainAclRole::kOwner;
  if (partition)
    return KeychainAclRole::kPartition;
  return KeychainAclRole::kUnrelated;
}

bool IsExpectedOwnerAcl(CFArrayRef authorizations, CFArrayRef applications) {
  if (authorizations == nullptr ||
      CFGetTypeID(authorizations) != CFArrayGetTypeID() ||
      CFArrayGetCount(authorizations) != 1 || applications == nullptr ||
      CFGetTypeID(applications) != CFArrayGetTypeID() ||
      CFArrayGetCount(applications) != 0) {
    return false;
  }
  return IsAuthorization(CFArrayGetValueAtIndex(authorizations, 0),
                         kSecACLAuthorizationChangeACL);
}

void IncludeKeychainAcl(KeychainAccessAclInspection &inspection,
                        KeychainAclRole role, CFArrayRef authorizations,
                        CFArrayRef applications, CFStringRef description,
                        SecKeychainPromptSelector prompt) {
  switch (role) {
  case KeychainAclRole::kOwner:
    inspection.ownerCount += 1;
    inspection.exact = inspection.exact &&
                       IsExpectedOwnerAcl(authorizations, applications);
    return;
  case KeychainAclRole::kPartition:
    inspection.partitionCount += 1;
    inspection.exact =
        inspection.exact &&
        IsExpectedPartitionAcl(authorizations, applications, description,
                               prompt);
    return;
  case KeychainAclRole::kUnrelated:
    return;
  case KeychainAclRole::kUnsafe:
    inspection.exact = false;
    return;
  }
}

bool IsExpectedKeychainAccess(
    const KeychainAccessAclInspection &inspection) {
  return inspection.exact && inspection.ownerCount == 1 &&
         inspection.partitionCount == 1;
}
