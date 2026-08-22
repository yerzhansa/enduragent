#include "partition-description.h"

#include <cstring>

namespace {

bool Equal(const char *left, const char *right) {
  return std::strcmp(left, right) == 0;
}

CFStringRef String(const char *value) {
  return CFStringCreateWithBytes(
      kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(value),
      static_cast<CFIndex>(std::strlen(value)), kCFStringEncodingUTF8, false);
}

int DescriptionStatus(int argumentCount, char **arguments) {
  CFMutableArrayRef descriptions = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (descriptions == nullptr)
    return 2;
  for (int index = 2; index < argumentCount; index += 1) {
    CFStringRef description = String(arguments[index]);
    if (description == nullptr) {
      CFRelease(descriptions);
      return 2;
    }
    CFArrayAppendValue(descriptions, description);
    CFRelease(description);
  }
  const bool acceptable = AreExpectedPartitionDescriptions(descriptions);
  CFRelease(descriptions);
  return acceptable ? 0 : 1;
}

int AclStatus(int argumentCount, char **arguments) {
  if (argumentCount != 6)
    return 2;
  CFMutableArrayRef authorizations = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (authorizations == nullptr)
    return 2;
  if (Equal(arguments[2], "exact") || Equal(arguments[2], "extra"))
    CFArrayAppendValue(authorizations, kSecACLAuthorizationPartitionID);
  if (Equal(arguments[2], "wrong") || Equal(arguments[2], "extra"))
    CFArrayAppendValue(authorizations, kSecACLAuthorizationDecrypt);
  if (!Equal(arguments[2], "exact") && !Equal(arguments[2], "wrong") &&
      !Equal(arguments[2], "extra")) {
    CFRelease(authorizations);
    return 2;
  }
  CFMutableArrayRef applications = nullptr;
  if (Equal(arguments[3], "empty") || Equal(arguments[3], "populated")) {
    applications = CFArrayCreateMutable(kCFAllocatorDefault, 0,
                                        &kCFTypeArrayCallBacks);
    if (applications == nullptr) {
      CFRelease(authorizations);
      return 2;
    }
    if (Equal(arguments[3], "populated"))
      CFArrayAppendValue(applications, CFSTR("application"));
  } else if (!Equal(arguments[3], "null")) {
    CFRelease(authorizations);
    return 2;
  }
  SecKeychainPromptSelector prompt{};
  if (Equal(arguments[4], "nonzero"))
    prompt = kSecKeychainPromptUnsigned;
  else if (!Equal(arguments[4], "zero")) {
    if (applications != nullptr)
      CFRelease(applications);
    CFRelease(authorizations);
    return 2;
  }
  CFStringRef description = String(arguments[5]);
  if (description == nullptr) {
    if (applications != nullptr)
      CFRelease(applications);
    CFRelease(authorizations);
    return 2;
  }
  const bool acceptable = IsExpectedPartitionAcl(
      authorizations, applications, description, prompt);
  CFRelease(description);
  if (applications != nullptr)
    CFRelease(applications);
  CFRelease(authorizations);
  return acceptable ? 0 : 1;
}

int CopyCount(const char *value) {
  if (Equal(value, "missing"))
    return 0;
  if (Equal(value, "single"))
    return 1;
  if (Equal(value, "duplicate"))
    return 2;
  return -1;
}

int AccessStatus(int argumentCount, char **arguments) {
  if (argumentCount != 8)
    return 2;
  const int ownerCopies = CopyCount(arguments[4]);
  const int partitionCopies = CopyCount(arguments[5]);
  if (ownerCopies < 0 || partitionCopies < 0)
    return 2;

  CFMutableArrayRef ownerAuthorizations = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (ownerAuthorizations == nullptr)
    return 2;
  if (Equal(arguments[2], "exact") || Equal(arguments[2], "extra"))
    CFArrayAppendValue(ownerAuthorizations, kSecACLAuthorizationChangeACL);
  if (Equal(arguments[2], "extra"))
    CFArrayAppendValue(ownerAuthorizations, kSecACLAuthorizationDecrypt);
  if (!Equal(arguments[2], "exact") && !Equal(arguments[2], "extra")) {
    CFRelease(ownerAuthorizations);
    return 2;
  }

  CFMutableArrayRef ownerApplications = nullptr;
  if (Equal(arguments[3], "empty") || Equal(arguments[3], "populated")) {
    ownerApplications = CFArrayCreateMutable(kCFAllocatorDefault, 0,
                                             &kCFTypeArrayCallBacks);
    if (ownerApplications == nullptr) {
      CFRelease(ownerAuthorizations);
      return 2;
    }
    if (Equal(arguments[3], "populated"))
      CFArrayAppendValue(ownerApplications, CFSTR("application"));
  } else if (!Equal(arguments[3], "null")) {
    CFRelease(ownerAuthorizations);
    return 2;
  }

  CFMutableArrayRef partitionAuthorizations = CFArrayCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  CFStringRef partitionDescription = String(arguments[7]);
  if (partitionAuthorizations == nullptr || partitionDescription == nullptr) {
    if (partitionAuthorizations != nullptr)
      CFRelease(partitionAuthorizations);
    if (partitionDescription != nullptr)
      CFRelease(partitionDescription);
    if (ownerApplications != nullptr)
      CFRelease(ownerApplications);
    CFRelease(ownerAuthorizations);
    return 2;
  }
  CFArrayAppendValue(partitionAuthorizations,
                     kSecACLAuthorizationPartitionID);

  KeychainAccessAclInspection inspection{0, 0, true};
  for (int index = 0; index < ownerCopies; index += 1) {
    IncludeKeychainAcl(inspection, ClassifyKeychainAcl(ownerAuthorizations),
                       ownerAuthorizations, ownerApplications, CFSTR("owner"),
                       SecKeychainPromptSelector{});
  }
  for (int index = 0; index < partitionCopies; index += 1) {
    IncludeKeychainAcl(
        inspection, ClassifyKeychainAcl(partitionAuthorizations),
        partitionAuthorizations, nullptr, partitionDescription,
        SecKeychainPromptSelector{});
  }

  CFMutableArrayRef unrelatedAuthorizations = nullptr;
  if (!Equal(arguments[6], "none")) {
    unrelatedAuthorizations = CFArrayCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
    if (unrelatedAuthorizations == nullptr) {
      CFRelease(partitionDescription);
      CFRelease(partitionAuthorizations);
      if (ownerApplications != nullptr)
        CFRelease(ownerApplications);
      CFRelease(ownerAuthorizations);
      return 2;
    }
    if (Equal(arguments[6], "default"))
      CFArrayAppendValue(unrelatedAuthorizations,
                         kSecACLAuthorizationEncrypt);
    else if (Equal(arguments[6], "any"))
      CFArrayAppendValue(unrelatedAuthorizations, kSecACLAuthorizationAny);
    else if (Equal(arguments[6], "change-owner"))
      CFArrayAppendValue(unrelatedAuthorizations,
                         kSecACLAuthorizationChangeOwner);
    else {
      CFRelease(unrelatedAuthorizations);
      CFRelease(partitionDescription);
      CFRelease(partitionAuthorizations);
      if (ownerApplications != nullptr)
        CFRelease(ownerApplications);
      CFRelease(ownerAuthorizations);
      return 2;
    }
    IncludeKeychainAcl(
        inspection, ClassifyKeychainAcl(unrelatedAuthorizations),
        unrelatedAuthorizations, nullptr, CFSTR("unrelated"),
        SecKeychainPromptSelector{});
  }

  const bool acceptable = IsExpectedKeychainAccess(inspection);
  if (unrelatedAuthorizations != nullptr)
    CFRelease(unrelatedAuthorizations);
  CFRelease(partitionDescription);
  CFRelease(partitionAuthorizations);
  if (ownerApplications != nullptr)
    CFRelease(ownerApplications);
  CFRelease(ownerAuthorizations);
  return acceptable ? 0 : 1;
}

}

int main(int argumentCount, char **arguments) {
  if (argumentCount < 2)
    return 2;
  if (Equal(arguments[1], "descriptions"))
    return DescriptionStatus(argumentCount, arguments);
  if (Equal(arguments[1], "acl"))
    return AclStatus(argumentCount, arguments);
  if (Equal(arguments[1], "access"))
    return AccessStatus(argumentCount, arguments);
  return 2;
}
